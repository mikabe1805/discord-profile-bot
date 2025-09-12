import 'dotenv/config';
import {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    InteractionType,
    PermissionFlagsBits
} from 'discord.js';

import {
    upsertGuild,
    upsertProfile,
    getProfile,
    listUserTags,
    addUserTag,
    addMultipleUserTags,
    removeUserTag,
    removeMultipleUserTags,
    addGuildTag,
    removeGuildTag,
    listGuildTags,
    searchGuildTags,
    getUsersByTag,
    getGuildConfig,
    setGuildConfig
} from './db_firebase.js';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('guildCreate', async(guild) => {
    try { await upsertGuild(guild.id); } catch (e) { console.error('upsertGuild error', e); }
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

client.on('interactionCreate', async(i) => {
            // Helper: try to defer once; return whether defer succeeded
            async function tryDeferEphemeral() {
                try {
                    if (!i.deferred && !i.replied) {
                        await i.deferReply({ flags: 64 });
                        return true;
                    }
                } catch (_) {}
                return false;
            }

            // Unified respond helper: edits if deferred, else replies
            async function respond(result) {
                const payload = typeof result === 'string' ? { content: result } : result;
                if (i.deferred) {
                    try { await i.editReply(payload); return; } catch (_) {}
                }
                if (!i.replied) {
                    try { await i.reply(Object.assign({ flags: 64 }, payload)); return; } catch (_) {}
                }
                try { await i.followUp(Object.assign({ flags: 64 }, payload)); } catch (_) {}
            }

            try {
                // -------- Autocomplete ----------
                if (i.type === InteractionType.ApplicationCommandAutocomplete) {
                    const focused = i.options.getFocused(true);
                    if (['tag', 'tags', 'name'].includes(focused.name)) {
                        const input = focused.value;

                        // Handle comma-separated input for tags
                        if (focused.name === 'tags') {
                            const parts = input.split(',');
                            const lastPart = parts[parts.length - 1].trim();

                            // If there's a comma and the last part is not empty, search for the last part
                            const searchQuery = parts.length > 1 && lastPart ? lastPart : input;
                            const rows = await searchGuildTags(i.guildId, searchQuery, 25);

                            // Format suggestions to show what the full input would look like
                            const matches = rows.map(t => {
                                if (parts.length > 1) {
                                    const prefix = parts.slice(0, -1).join(', ') + ', ';
                                    return {
                                        name: `${prefix}${t.display_name}`,
                                        value: `${prefix}${t.tag_slug}`
                                    };
                                } else {
                                    return { name: t.display_name, value: t.tag_slug };
                                }
                            });

                            await i.respond(matches);
                        } else {
                            // Regular single tag search
                            const rows = await searchGuildTags(i.guildId, input, 25);
                            const matches = rows.map(t => ({ name: t.display_name, value: t.tag_slug }));
                            await i.respond(matches);
                        }
                    }
                    return;
                }

                if (!i.isChatInputCommand()) return;
                const name = i.commandName;

                // -------- profile_set -----------
                if (name === 'profile_set') {
                    const bio = i.options.getString('bio', true);
                    const image = i.options.getAttachment('image');
                    await i.deferReply({ flags: 64 });

                    let imageUrl = null;
                    if (image) {
                        // Validate image
                        const contentType = image.contentType || '';
                        if (!contentType.startsWith('image/')) {
                            return i.editReply('❌ Please provide a valid image file.');
                        }
                        if (image.size > 8 * 1024 * 1024) { // 8MB limit
                            return i.editReply('❌ Image file is too large. Please use an image under 8MB.');
                        }
                        imageUrl = image.url;
                    }

                    await upsertProfile(i.guildId, i.user.id, bio, imageUrl);
                    const message = imageUrl ? '✅ Saved your bio and profile image!' : '✅ Saved your bio.';
                    await i.editReply(message);
                    return;
                }

                // -------- profile_image -----------
                if (name === 'profile_image') {
                    const image = i.options.getAttachment('image');
                    await i.deferReply({ flags: 64 });

                    // Validate image
                    const contentType = image.contentType || '';
                    if (!contentType.startsWith('image/')) {
                        return i.editReply('❌ Please provide a valid image file.');
                    }
                    if (image.size > 8 * 1024 * 1024) { // 8MB limit
                        return i.editReply('❌ Image file is too large. Please use an image under 8MB.');
                    }

                    // Get current profile to preserve bio
                    const currentProfile = await getProfile(i.guildId, i.user.id);
                    const currentBio = currentProfile ? currentProfile.bio : '';

                    await upsertProfile(i.guildId, i.user.id, currentBio, image.url);
                    await i.editReply('✅ Profile image updated!');
                    return;
                }

                // -------- profile_showp (private)
                if (name === 'profile_showp') {
                    const user = i.options.getUser('user') || i.user;
                    await i.deferReply({ flags: 64 });
                    const embed = await renderProfileEmbed(i.guildId, user);
                    await i.editReply({ embeds: [embed] });
                    return;
                }

                // -------- profile_showv (public)
                if (name === 'profile_showv') {
                    const user = i.options.getUser('user') || i.user;
                    await i.deferReply();
                    const embed = await renderProfileEmbed(i.guildId, user);
                    await i.editReply({ embeds: [embed] });
                    return;
                }

                // -------- profile_addtag --------
                if (name === 'profile_addtag') {
                    const rawTags = i.options.getString('tags', true);
                    const tagList = rawTags.split(',').map(t => normalizeTag(t.trim())).filter(t => t.length > 0);

                    if (tagList.length === 0) {
                        return i.reply({ content: 'Please provide at least one valid tag.', flags: 64 });
                    }

                    // Try defer once
                    const deferred = await tryDeferEphemeral();

                    try {
                        const results = await addMultipleUserTags(i.guildId, i.user.id, tagList);

                        if (results.success.length === 0) {
                            await respond('No tags were added. Check if you\'ve reached the limit or if tags already exist.');
                        } else if (results.failed.length === 0) {
                            await respond(`✅ Successfully added ${results.success.length} tag(s): ${results.success.map(t => `\`${t}\``).join(', ')}`);
                        } else {
                            await respond(`✅ Added ${results.success.length} tag(s): ${results.success.map(t => `\`${t}\``).join(', ')}\n❌ Failed to add ${results.failed.length} tag(s): ${results.failed.map(t => `\`${t}\``).join(', ')}`);
                        }
                    } catch (error) {
                        console.log('Error adding tags:', error);
                        try {
                            await respond('❌ An error occurred while adding tags. Please try again.');
                        } catch (_) {}
                    }
                    return;
                }

    // -------- profile_removetag -----
    if (name === 'profile_removetag') {
      const rawTags = i.options.getString('tags', true);
      const tagList = rawTags.split(',').map(t => normalizeTag(t.trim())).filter(t => t.length > 0);
      
      if (tagList.length === 0) {
        return i.reply({ content: 'Please provide at least one valid tag.', flags: 64 });
      }
      
      // Try defer once
      const deferred = await tryDeferEphemeral();
      
      try {
        const results = await removeMultipleUserTags(i.guildId, i.user.id, tagList);
        
        if (results.success.length === 0) {
          await respond('No tags were removed. Check if the tags exist on your profile.');
        } else if (results.failed.length === 0) {
          await respond(`✅ Successfully removed ${results.success.length} tag(s): ${results.success.map(t => `\`${t}\``).join(', ')}`);
        } else {
          await respond(`✅ Removed ${results.success.length} tag(s): ${results.success.map(t => `\`${t}\``).join(', ')}\n❌ Failed to remove ${results.failed.length} tag(s): ${results.failed.map(t => `\`${t}\``).join(', ')}`);
        }
      } catch (error) {
        console.log('Error removing tags:', error);
        try {
          await respond('❌ An error occurred while removing tags. Please try again.');
        } catch (_) {}
      }
      return;
    }

    // -------- findp (private)
    if (name === 'findp') {
      const slug = normalizeTag(i.options.getString('tag', true));
      await replyUserList(i, slug, false);
      return;
    }

    // -------- findv (public)
    if (name === 'findv') {
      const slug = normalizeTag(i.options.getString('tag', true));
      await replyUserList(i, slug, true);
      return;
    }

    // -------- tags_add --------------
    if (name === 'tags_add') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const nameOpt = i.options.getString('name', true);
      const display = i.options.getString('display', true);
      const category = i.options.getString('category') || 'general';
      await i.deferReply({ flags: 64 });
      await addGuildTag(i.guildId, normalizeTag(nameOpt), display, i.user.id, category);
      await i.editReply(`✅ Upserted tag \`${display}\` (\`${normalizeTag(nameOpt)}\`) in category \`${category}\`.`);
      return;
    }

    // -------- tags_remove -----------
    if (name === 'tags_remove') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const nameOpt = i.options.getString('name', true);
      await i.deferReply({ flags: 64 });
      await removeGuildTag(i.guildId, normalizeTag(nameOpt));
      await i.editReply(`Removed tag \`${normalizeTag(nameOpt)}\`.`);
      return;
    }

    // -------- tags_list -------------
    if (name === 'tags_list') {
      await i.deferReply({ flags: 64 });
      const tags = await listGuildTags(i.guildId);
      
      if (!tags.length) {
        await i.editReply('*No tags available.*');
        return;
      }
      
      // Group tags by category
      const categories = {};
      tags.forEach(tag => {
        const category = tag.category || 'general';
        if (!categories[category]) {
          categories[category] = [];
        }
        categories[category].push(tag);
      });
      
      // Format by category
      const categoryEmojis = {
        'general': '🏷️',
        'skills': '⚡',
        'interests': '❤️',
        'hobbies': '🎯',
        'profession': '💼',
        'gaming': '🎮',
        'creative': '🎨',
        'sports': '⚽',
        'music': '🎵',
        'tech': '💻',
        'education': '📚',
        'languages': '🌍'
      };
      
      let output = '';
      Object.entries(categories).forEach(([category, categoryTags]) => {
        const emoji = categoryEmojis[category] || '🏷️';
        output += `\n${emoji} **${category.charAt(0).toUpperCase() + category.slice(1)}**\n`;
        categoryTags.forEach(tag => {
          output += `• ${tag.display_name} (\`${tag.tag_slug}\`)\n`;
        });
      });
      
      await i.editReply(output.slice(0, 1900));
      return;
    }

    // -------- config_get ------------
    if (name === 'config_get') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      await i.deferReply({ flags: 64 });
      const cfg = await getGuildConfig(i.guildId);
      await i.editReply(`allow_ugc_tags: \`${cfg.allow_ugc_tags}\`\nmax_tags_per_user: \`${cfg.max_tags_per_user}\``);
      return;
    }

    // -------- config_set ------------
    if (name === 'config_set') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const allow = i.options.getBoolean('allow_ugc_tags');
      const max = i.options.getInteger('max_tags_per_user');
      const patch = {};
      if (allow !== null) patch.allow_ugc_tags = allow;
      if (max !== null) patch.max_tags_per_user = Math.max(1, max);
      await i.deferReply({ flags: 64 });
      await setGuildConfig(i.guildId, patch);
      const cfg = await getGuildConfig(i.guildId);
      await i.editReply(`Updated.\nallow_ugc_tags: \`${cfg.allow_ugc_tags}\`\nmax_tags_per_user: \`${cfg.max_tags_per_user}\``);
      return;
    }

    // -------- theme_set ------------
    if (name === 'theme_set') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const theme = i.options.getString('theme', true);
      await i.deferReply({ flags: 64 });
      await setGuildConfig(i.guildId, { profile_theme: theme });
      await i.editReply(`✅ Profile theme set to \`${theme}\`. Use \`/theme_preview\` to see how it looks!`);
      return;
    }

    // -------- theme_preview ------------
    if (name === 'theme_preview') {
      const theme = i.options.getString('theme', true);
      await i.deferReply({ flags: 64 });
      
      // Create a preview with the selected theme
      const previewConfig = { profile_theme: theme, custom_colors: null };
      const colors = generateThemeColors(previewConfig, i.user.id);
      const themeStyle = getThemeStyle(theme);
      
      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: `${i.user.displayName || i.user.username}`, 
          iconURL: i.user.displayAvatarURL({ dynamic: true, size: 256 })
        })
        .setTitle(themeStyle.title)
        .setDescription('*This is how your profile will look with this theme!*')
        .setColor(colors.primary)
        .setThumbnail(i.user.displayAvatarURL({ dynamic: true, size: 512 }))
        .addFields(
          { 
            name: themeStyle.fields.tags, 
            value: '`example-tag` • `another-tag` • `sample-tag`', 
            inline: false 
          }
        )
        .setFooter({ 
          text: `Theme: ${theme} • Preview`, 
          iconURL: i.user.displayAvatarURL({ dynamic: true, size: 32 })
        })
        .setTimestamp();
        
      await i.editReply({ embeds: [embed] });
      return;
    }

    // -------- help ------------
    if (name === 'help') {
      const category = i.options.getString('category') || 'getting-started';
      await i.deferReply({ flags: 64 });
      
      const helpEmbed = generateHelpEmbed(category, i.user);
      await i.editReply({ embeds: [helpEmbed] });
      return;
    }

    // -------- quickstart ------------
    if (name === 'quickstart') {
      await i.deferReply({ flags: 64 });
      
      // Check if user already has a profile
      const existingProfile = await getProfile(i.guildId, i.user.id);
      const existingTags = await listUserTags(i.guildId, i.user.id);
      
      if (existingProfile?.bio && existingTags.length > 0) {
        const embed = new EmbedBuilder()
          .setAuthor({ 
            name: 'Profile Bot Quickstart', 
            iconURL: i.user.displayAvatarURL({ dynamic: true, size: 256 })
          })
          .setTitle('✅ You\'re All Set!')
          .setDescription('You already have a profile set up! Here\'s what you can do next:')
          .setColor('#57F287')
          .addFields(
            {
              name: '🔍 Find People',
              value: 'Use `/findp <tag>` to find others with similar interests',
              inline: false
            },
            {
              name: '👀 View Your Profile',
              value: 'Use `/profile_showp` to see how your profile looks',
              inline: false
            },
            {
              name: '🏷️ Add More Tags',
              value: 'Use `/profile_addtag` to add more skills and interests',
              inline: false
            },
            {
              name: '📚 Learn More',
              value: 'Use `/help` to explore all available commands',
              inline: false
            }
          )
          .setFooter({ 
            text: 'Profile Bot • You\'re ready to go!',
            iconURL: i.user.displayAvatarURL({ dynamic: true, size: 32 })
          })
          .setTimestamp();
          
        await i.editReply({ embeds: [embed] });
        return;
      }
      
      // Show quickstart guide for new users
      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: 'Profile Bot Quickstart', 
          iconURL: i.user.displayAvatarURL({ dynamic: true, size: 256 })
        })
        .setTitle('🚀 Welcome to Profile Bot!')
        .setDescription('Let\'s get your profile set up in just a few steps:')
        .setColor('#5865F2')
        .addFields(
          {
            name: '📝 Step 1: Add Your Bio',
            value: 'Use `/profile_set` to tell others about yourself!\n*Example: "Hi! I\'m a developer who loves creating Discord bots and helping communities."*',
            inline: false
          },
          {
            name: '🏷️ Step 2: Add Some Tags',
            value: 'Use `/profile_addtag` to add your skills and interests!\n*Example: `/profile_addtag javascript, gaming, photography`*',
            inline: false
          },
          {
            name: '👀 Step 3: Check It Out',
            value: 'Use `/profile_showp` to see how your profile looks!',
            inline: false
          },
          {
            name: '🔍 Step 4: Find Others',
            value: 'Use `/findp <tag>` to find people with similar interests!',
            inline: false
          },
          {
            name: '💡 Pro Tips',
            value: '• You can add multiple tags at once by separating them with commas\n• Use `/tags_list` to see what tags are available\n• Ask mods to add server-specific tags\n• Use `/help` for detailed command information',
            inline: false
          }
        )
        .setFooter({ 
          text: 'Need help? Use /help for detailed guides!',
          iconURL: i.user.displayAvatarURL({ dynamic: true, size: 32 })
        })
        .setTimestamp();
        
      await i.editReply({ embeds: [embed] });
      return;
    }

  } catch (err) {
    console.error('interaction error:', err);
    if (i.isRepliable()) {
      try {
        if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
        await i.editReply('Error. Check bot logs for details.');
      } catch (_) {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// ---- helpers ----
function normalizeTag(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}
function isMod(i) {
  return i.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function renderProfileEmbed(guildId, user) {
  const prof = await getProfile(guildId, user.id);
  const tags = await listUserTags(guildId, user.id);
  const guildConfig = await getGuildConfig(guildId);
  
  // Generate colors based on server theme
  const colors = generateThemeColors(guildConfig, user.id);
  
  // Create tag display grouped by category with better visuals
  const tagDisplay = tags.length 
    ? formatTagsByCategory(tags)
    : '*No tags added yet*';
  
  // Get theme-specific styling
  const theme = getThemeStyle(guildConfig.profile_theme);
  
  // Use custom profile image if available
  const profileImage = prof?.profile_image || null;
  
  const embed = new EmbedBuilder()
    .setAuthor({ 
      name: `${user.displayName || user.username}`, 
      iconURL: user.displayAvatarURL({ dynamic: true, size: 256 })
    })
    .setTitle(theme.title)
    .setDescription((prof?.bio || '*No bio set. Use `/profile_set` to add one!*').slice(0, 1000))
    .setColor(colors.primary)
    .addFields(
      { 
        name: theme.fields.tags, 
        value: tagDisplay, 
        inline: false 
      }
    )
    .setFooter({ 
      text: `ID: ${user.id} • ${tags.length} tag${tags.length !== 1 ? 's' : ''}`, 
      iconURL: user.displayAvatarURL({ dynamic: true, size: 32 })
    })
    .setTimestamp();
    
  // Only show a large image when the user set a custom profile image
  if (profileImage) {
    embed.setImage(profileImage);
    embed.setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }));
  } else {
    embed.setThumbnail(user.displayAvatarURL({ dynamic: true, size: 512 }));
  }
  return embed;
}

// Removed completion meter per user request

function generateThemeColors(guildConfig, userId) {
  // Use custom colors if set, otherwise generate based on theme
  if (guildConfig.custom_colors) {
    return {
      primary: guildConfig.custom_colors.primary,
      secondary: guildConfig.custom_colors.secondary
    };
  }
  
  const theme = guildConfig.profile_theme || 'default';
  const themeColors = getThemeColors(theme);
  
  if (theme === 'user-based') {
    // Generate user-specific colors
    const hash = userId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    
    const hue = Math.abs(hash) % 360;
    const saturation = 70 + (Math.abs(hash) % 30);
    const lightness = 50 + (Math.abs(hash) % 20);
    
    return {
      primary: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
      secondary: `hsl(${(hue + 30) % 360}, ${saturation}%, ${lightness + 10}%)`
    };
  }
  
  return themeColors;
}

function getThemeColors(theme) {
  // Curated small set with distinctive, cohesive palettes
  const themes = {
    default: { primary: '#5865F2', secondary: '#99A6FF' },            // Discord-like indigo
    blossom: { primary: '#FF6FA0', secondary: '#FFD1DC' },            // Pink blossom
    ocean: { primary: '#2EC4B6', secondary: '#B2F7EF' },              // Aqua ocean
    sunset: { primary: '#FF7F50', secondary: '#FFD1A9' },             // Coral sunset
    midnight: { primary: '#1F2937', secondary: '#6B7280' }            // Dark elegant
  };
  return themes[theme] || themes.default;
}

function getThemeStyle(theme) {
  // Simplified styles focused on pretty visuals for tags + colors
  const styles = {
    default: {
      title: '🌟 Profile',
      fields: { tags: '🏷️ Tags' }
    },
    blossom: {
      title: '🌸 Profile',
      fields: { tags: '✨ Highlights' }
    },
    ocean: {
      title: '🌊 Profile',
      fields: { tags: '🪼 Traits' }
    },
    sunset: {
      title: '🌇 Profile',
      fields: { tags: '🔥 Interests' }
    },
    midnight: {
      title: '🌙 Profile',
      fields: { tags: '💠 Tags' }
    }
  };
  return styles[theme] || styles.default;
}

function formatTagsByCategory(tags) {
  // Group tags by category
  const categories = {};
  tags.forEach(tag => {
    const category = tag.category || 'general';
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(tag.display_name);
  });
  
  // Enhanced category styling with colors and better emojis
  const categoryStyles = {
    'general': { emoji: '🏷️', color: '🔵', name: 'General' },
    'skills': { emoji: '⚡', color: '🟡', name: 'Skills & Expertise' },
    'interests': { emoji: '❤️', color: '🔴', name: 'Interests' },
    'hobbies': { emoji: '🎯', color: '🟢', name: 'Hobbies' },
    'profession': { emoji: '💼', color: '🔵', name: 'Profession' },
    'gaming': { emoji: '🎮', color: '🟣', name: 'Gaming' },
    'creative': { emoji: '🎨', color: '🟠', name: 'Creative' },
    'sports': { emoji: '⚽', color: '🟢', name: 'Sports & Fitness' },
    'music': { emoji: '🎵', color: '🟡', name: 'Music' },
    'tech': { emoji: '💻', color: '🔵', name: 'Technology' },
    'education': { emoji: '📚', color: '🟤', name: 'Education' },
    'languages': { emoji: '🌍', color: '🟢', name: 'Languages' }
  };
  
  const formatted = Object.entries(categories).map(([category, tagNames]) => {
    const style = categoryStyles[category] || categoryStyles['general'];
    const tags = tagNames.map(name => `\`${name}\``).join(' • ');
    return `${style.color} ${style.emoji} **${style.name}**\n${tags}`;
  });
  
  return formatted.join('\n\n');
}

function generateHelpEmbed(category, user) {
  const baseEmbed = new EmbedBuilder()
    .setAuthor({ 
      name: 'Profile Bot Help', 
      iconURL: user.displayAvatarURL({ dynamic: true, size: 256 })
    })
    .setColor('#5865F2')
    .setFooter({ 
      text: 'Use /help <category> for specific help sections',
      iconURL: user.displayAvatarURL({ dynamic: true, size: 32 })
    })
    .setTimestamp();

  switch (category) {
    case 'getting-started':
      return baseEmbed
        .setTitle('🚀 Getting Started with Profile Bot')
        .setDescription('Welcome to the Profile Bot! This bot helps you create and manage your Discord profile with tags and bios.')
        .addFields(
          {
            name: '📝 Step 1: Set Your Bio',
            value: 'Use `/profile_set` to add a bio that describes yourself. This will be shown on your profile.',
            inline: false
          },
          {
            name: '🏷️ Step 2: Add Tags',
            value: 'Use `/profile_addtag` to add tags that represent your skills, interests, or hobbies. You can add multiple tags at once by separating them with commas!',
            inline: false
          },
          {
            name: '👀 Step 3: View Profiles',
            value: 'Use `/profile_showp` to view your own profile privately, or `/profile_showv` to view any profile publicly.',
            inline: false
          },
          {
            name: '🔍 Step 4: Find People',
            value: 'Use `/findp` or `/findv` to search for users by tags. Great for finding people with similar interests!',
            inline: false
          },
          {
            name: '💡 Pro Tips',
            value: '• Use `/help profile` for all profile commands\n• Use `/help tags` for tag management\n• Use `/help themes` to customize your server\'s look\n• Ask mods to add server-specific tags with `/tags_add`',
            inline: false
          }
        );

    case 'profile':
      return baseEmbed
        .setTitle('👤 Profile Commands')
        .setDescription('Commands for managing your personal profile')
        .addFields(
          {
            name: '`/profile_set <bio>`',
            value: 'Set or update your bio (up to 1000 characters)',
            inline: false
          },
          {
            name: '`/profile_showp [user]`',
            value: 'View a profile privately (shows only to you)',
            inline: false
          },
          {
            name: '`/profile_showv [user]`',
            value: 'View a profile publicly (everyone can see)',
            inline: false
          },
          {
            name: '`/profile_addtag <tags>`',
            value: 'Add one or more tags to your profile. Separate multiple tags with commas!',
            inline: false
          },
          {
            name: '`/profile_removetag <tags>`',
            value: 'Remove one or more tags from your profile. Separate multiple tags with commas!',
            inline: false
          }
        );

    case 'tags':
      return baseEmbed
        .setTitle('🏷️ Tag Commands')
        .setDescription('Commands for managing tags and finding people')
        .addFields(
          {
            name: '`/findp <tag>`',
            value: 'Find users with a specific tag (private results)',
            inline: false
          },
          {
            name: '`/findv <tag>`',
            value: 'Find users with a specific tag (public results)',
            inline: false
          },
          {
            name: '`/tags_list`',
            value: 'List all available tags organized by category',
            inline: false
          },
          {
            name: '`/tags_add <name> <display> [category]`',
            value: 'Add a new tag to the server (moderator only)',
            inline: false
          },
          {
            name: '`/tags_remove <name>`',
            value: 'Remove a tag from the server (moderator only)',
            inline: false
          },
          {
            name: '📂 Tag Categories',
            value: 'Tags are organized into categories like Skills, Interests, Hobbies, Gaming, etc. This helps keep profiles organized!',
            inline: false
          }
        );

    case 'themes':
      return baseEmbed
        .setTitle('🎨 Theme Commands')
        .setDescription('Customize how profiles look in your server')
        .addFields(
          {
            name: '`/theme_preview <theme>`',
            value: 'Preview how a theme will look on profiles',
            inline: false
          },
          {
            name: '`/theme_set <theme>`',
            value: 'Set the server\'s profile theme (moderator only)',
            inline: false
          },
          {
            name: '🎭 Available Themes',
            value: '• 🌟 Default - Clean and professional\n• 🎮 Gaming - Perfect for gaming communities\n• 💼 Professional - Great for work servers\n• 🎨 Creative - For artists and creators\n• 🌿 Nature - Earthy and organic feel\n• 🌊 Ocean - Cool blue tones\n• 🌅 Sunset - Warm orange and pink\n• ⚡ Neon - Bright and vibrant\n• ⚫ Monochrome - Black and white\n• 👤 User-based - Unique colors per user',
            inline: false
          },
          {
            name: '💡 Theme Features',
            value: 'Each theme changes:\n• Profile colors and styling\n• Field names and emojis\n• Progress bar appearance\n• Overall visual theme',
            inline: false
          }
        );

    case 'admin':
      return baseEmbed
        .setTitle('⚙️ Admin Commands')
        .setDescription('Commands for server administrators and moderators')
        .addFields(
          {
            name: '`/config_get`',
            value: 'View current bot configuration',
            inline: false
          },
          {
            name: '`/config_set [allow_ugc_tags] [max_tags_per_user]`',
            value: 'Configure bot settings:\n• `allow_ugc_tags`: Let members create new tags\n• `max_tags_per_user`: Limit tags per user (default: 30)',
            inline: false
          },
          {
            name: '`/theme_set <theme>`',
            value: 'Set the server\'s profile theme',
            inline: false
          },
          {
            name: '`/tags_add <name> <display> [category]`',
            value: 'Add official server tags with categories',
            inline: false
          },
          {
            name: '`/tags_remove <name>`',
            value: 'Remove tags from the server',
            inline: false
          },
          {
            name: '🔧 Configuration Tips',
            value: '• Set `allow_ugc_tags` to false for curated tag lists\n• Adjust `max_tags_per_user` based on your community size\n• Use categories to organize different types of tags\n• Preview themes before applying them',
            inline: false
          }
        );

    case 'search':
      return baseEmbed
        .setTitle('🔍 Search Commands')
        .setDescription('Find people and discover connections in your server')
        .addFields(
          {
            name: '`/findp <tag>`',
            value: 'Find users with a specific tag (private results - only you can see)',
            inline: false
          },
          {
            name: '`/findv <tag>`',
            value: 'Find users with a specific tag (public results - everyone can see)',
            inline: false
          },
          {
            name: '`/profile_showp [user]`',
            value: 'View someone\'s full profile privately',
            inline: false
          },
          {
            name: '`/profile_showv [user]`',
            value: 'View someone\'s full profile publicly',
            inline: false
          },
          {
            name: '`/tags_list`',
            value: 'Browse all available tags organized by category',
            inline: false
          },
          {
            name: '💡 Search Tips',
            value: '• Use autocomplete when typing tag names\n• Try searching for broad categories like "gaming" or "art"\n• Check `/tags_list` to see what tags are available\n• Use private search (`/findp`) for personal discovery\n• Use public search (`/findv`) to share findings with others',
            inline: false
          }
        );

    default:
      return baseEmbed
        .setTitle('❓ Help Categories')
        .setDescription('Choose a category to get specific help:')
        .addFields(
          { name: '🚀 Getting Started', value: '`/help getting-started` - New user guide', inline: true },
          { name: '👤 Profile Commands', value: '`/help profile` - Profile management', inline: true },
          { name: '🏷️ Tag Commands', value: '`/help tags` - Tag system', inline: true },
          { name: '🎨 Theme Commands', value: '`/help themes` - Customization', inline: true },
          { name: '⚙️ Admin Commands', value: '`/help admin` - Moderation tools', inline: true },
          { name: '🔍 Search Commands', value: '`/help search` - Finding people', inline: true }
        );
  }
}
async function replyUserList(i, slug, publicVisible) {
  await i.deferReply(publicVisible ? {} : { flags: 64 });
  const users = (await getUsersByTag(i.guildId, slug, 5000, 0)).map(r => r.user_id);
  if (!users.length) return i.editReply(`No users found with \`${slug}\`.`);
  const chunks = chunk(users.map(id => `<@${id}>`), 30);
  await i.editReply(`Found ${users.length} user(s) for \`${slug}\`.\n${chunks[0].join(' ')}`);
  for (let c = 1; c < chunks.length; c++) {
    await i.followUp(publicVisible ? { content: chunks[c].join(' ') } : { content: chunks[c].join(' '), flags: 64 });
  }
}