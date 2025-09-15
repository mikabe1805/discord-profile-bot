import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = path.dirname(__filename);

// Create database connection
const dbPath = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(dbPath);

// Initialize database with tables
function initDatabase() {
    try {
        // Create guilds table
        db.exec(`
            CREATE TABLE IF NOT EXISTS guilds (
                guild_id TEXT PRIMARY KEY,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                allow_ugc_tags BOOLEAN DEFAULT 1,
                max_tags_per_user INTEGER DEFAULT 30,
                profile_theme TEXT DEFAULT 'default',
                custom_colors TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create profiles table
        db.exec(`
            CREATE TABLE IF NOT EXISTS profiles (
                guild_id TEXT,
                user_id TEXT,
                bio TEXT DEFAULT '',
                profile_image TEXT,
                tags TEXT DEFAULT '[]',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id),
                FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
            )
        `);

        // Create tags table
        db.exec(`
            CREATE TABLE IF NOT EXISTS tags (
                guild_id TEXT,
                tag_slug TEXT,
                display_name TEXT,
                created_by TEXT,
                category TEXT DEFAULT 'general',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, tag_slug),
                FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
            )
        `);

        // Create tag_members table (many-to-many relationship)
        db.exec(`
            CREATE TABLE IF NOT EXISTS tag_members (
                guild_id TEXT,
                tag_slug TEXT,
                user_id TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, tag_slug, user_id),
                FOREIGN KEY (guild_id, tag_slug) REFERENCES tags(guild_id, tag_slug),
                FOREIGN KEY (guild_id, user_id) REFERENCES profiles(guild_id, user_id)
            )
        `);

        // Create user_themes table
        db.exec(`
            CREATE TABLE IF NOT EXISTS user_themes (
                guild_id TEXT,
                user_id TEXT,
                theme TEXT,
                primary_color TEXT,
                secondary_color TEXT,
                title TEXT,
                tags_emoji TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id),
                FOREIGN KEY (guild_id, user_id) REFERENCES profiles(guild_id, user_id)
            )
        `);

        // Create feature_configs table
        db.exec(`
            CREATE TABLE IF NOT EXISTS feature_configs (
                guild_id TEXT,
                ping_threads BOOLEAN DEFAULT 1,
                user_customization BOOLEAN DEFAULT 1,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id),
                FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
            )
        `);

        // Create indexes for better performance
        db.exec(`CREATE INDEX IF NOT EXISTS idx_profiles_guild_user ON profiles(guild_id, user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_guild ON tags(guild_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_members_guild_tag ON tag_members(guild_id, tag_slug)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_members_user ON tag_members(guild_id, user_id)`);

        console.log('✅ SQLite database initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
        throw error;
    }
}

// Initialize database on import
initDatabase();

// ---- Guild bootstrap ----
export async function upsertGuild(guild_id) {
    try {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO guilds (guild_id, created_at) 
            VALUES (?, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id);
    } catch (error) {
        console.error('Error upserting guild:', error);
        throw error;
    }
}

// ---- Profiles ----
export async function upsertProfile(guild_id, user_id, bio = '', profile_image = null) {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO profiles (guild_id, user_id, bio, profile_image, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id, user_id, bio, profile_image);
    } catch (error) {
        console.error('Error upserting profile:', error);
        throw error;
    }
}

export async function getProfile(guild_id, user_id) {
    try {
        const stmt = db.prepare(`
            SELECT bio, profile_image, tags FROM profiles 
            WHERE guild_id = ? AND user_id = ?
        `);
        const row = stmt.get(guild_id, user_id);

        if (!row) return null;

        return {
            bio: row.bio,
            profile_image: row.profile_image,
            tags: JSON.parse(row.tags || '[]')
        };
    } catch (error) {
        console.error('Error getting profile:', error);
        throw error;
    }
}

// ---- Guild config ----
export async function getGuildConfig(guild_id) {
    try {
        const stmt = db.prepare(`
            SELECT allow_ugc_tags, max_tags_per_user, profile_theme, custom_colors 
            FROM guilds WHERE guild_id = ?
        `);
        const row = stmt.get(guild_id);

        if (!row) {
            // Return defaults if guild doesn't exist
            return {
                allow_ugc_tags: true,
                max_tags_per_user: 30,
                profile_theme: 'default',
                custom_colors: null
            };
        }

        return {
            allow_ugc_tags: Boolean(row.allow_ugc_tags),
            max_tags_per_user: row.max_tags_per_user || 30,
            profile_theme: row.profile_theme || 'default',
            custom_colors: row.custom_colors ? JSON.parse(row.custom_colors) : null
        };
    } catch (error) {
        console.error('Error getting guild config:', error);
        throw error;
    }
}

export async function setGuildConfig(guild_id, patch) {
    try {
        const updates = [];
        const values = [];

        if (patch.allow_ugc_tags !== undefined) {
            updates.push('allow_ugc_tags = ?');
            values.push(patch.allow_ugc_tags);
        }
        if (patch.max_tags_per_user !== undefined) {
            updates.push('max_tags_per_user = ?');
            values.push(patch.max_tags_per_user);
        }
        if (patch.profile_theme !== undefined) {
            updates.push('profile_theme = ?');
            values.push(patch.profile_theme);
        }
        if (patch.custom_colors !== undefined) {
            updates.push('custom_colors = ?');
            values.push(JSON.stringify(patch.custom_colors));
        }

        if (updates.length === 0) return;

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(guild_id);

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO guilds (guild_id, ${Object.keys(patch).join(', ')}, updated_at)
            VALUES (?, ${Object.keys(patch).map(() => '?').join(', ')}, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id, ...Object.values(patch));
    } catch (error) {
        console.error('Error setting guild config:', error);
        throw error;
    }
}

// ---- Tags (dictionary) ----
export async function addGuildTag(guild_id, tag_slug, display_name, created_by, category = 'general') {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO tags (guild_id, tag_slug, display_name, created_by, category, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id, tag_slug, display_name, created_by, category);
    } catch (error) {
        console.error('Error adding guild tag:', error);
        throw error;
    }
}

export async function removeGuildTag(guild_id, tag_slug) {
    try {
        // Remove all members first
        const deleteMembers = db.prepare(`
            DELETE FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ?
        `);
        deleteMembers.run(guild_id, tag_slug);

        // Remove the tag
        const deleteTag = db.prepare(`
            DELETE FROM tags 
            WHERE guild_id = ? AND tag_slug = ?
        `);
        deleteTag.run(guild_id, tag_slug);
    } catch (error) {
        console.error('Error removing guild tag:', error);
        throw error;
    }
}

export async function listGuildTags(guild_id) {
    try {
        const stmt = db.prepare(`
            SELECT tag_slug, display_name, category 
            FROM tags 
            WHERE guild_id = ? 
            ORDER BY display_name
        `);
        const rows = stmt.all(guild_id);

        return rows.map(row => ({
            tag_slug: row.tag_slug,
            display_name: row.display_name,
            category: row.category || 'general'
        }));
    } catch (error) {
        console.error('Error listing guild tags:', error);
        throw error;
    }
}

export async function searchGuildTags(guild_id, qstr, limit = 25) {
    try {
        let query = `
            SELECT tag_slug, display_name, category 
            FROM tags 
            WHERE guild_id = ?
        `;
        const params = [guild_id];

        if (qstr) {
            query += ` AND (display_name LIKE ? OR tag_slug LIKE ?)`;
            params.push(`%${qstr}%`, `%${qstr}%`);
        }

        query += ` ORDER BY display_name LIMIT ?`;
        params.push(limit);

        const stmt = db.prepare(query);
        const rows = stmt.all(...params);

        return rows.map(row => ({
            tag_slug: row.tag_slug,
            display_name: row.display_name,
            category: row.category || 'general'
        }));
    } catch (error) {
        console.error('Error searching guild tags:', error);
        throw error;
    }
}

// ---- User tags (membership edges) ----
export async function addUserTag(guild_id, user_id, tag_slug) {
    try {
        const cfg = await getGuildConfig(guild_id);

        // Check if tag exists, create if allowed
        const tagExists = db.prepare(`
            SELECT 1 FROM tags WHERE guild_id = ? AND tag_slug = ?
        `).get(guild_id, tag_slug);

        if (!tagExists) {
            if (!cfg.allow_ugc_tags) {
                const e = new Error('UGC tags are disabled in this server.');
                e.code = 'UGC_DISABLED';
                throw e;
            }

            const createTag = db.prepare(`
                INSERT INTO tags (guild_id, tag_slug, display_name, created_by, created_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            createTag.run(guild_id, tag_slug, tagSlugToDisplay(tag_slug), user_id);
        }

        // Check current tag count
        const currentTags = db.prepare(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `).all(guild_id, user_id);

        if (currentTags.length >= cfg.max_tags_per_user) {
            const e = new Error(`Max tags per user reached (${cfg.max_tags_per_user}).`);
            e.code = 'LIMIT_REACHED';
            throw e;
        }

        // Add user to tag
        const addMember = db.prepare(`
            INSERT OR IGNORE INTO tag_members (guild_id, tag_slug, user_id, added_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `);
        addMember.run(guild_id, tag_slug, user_id);

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);
    } catch (error) {
        console.error('Error adding user tag:', error);
        throw error;
    }
}

export async function addMultipleUserTags(guild_id, user_id, tag_slugs) {
    try {
        const cfg = await getGuildConfig(guild_id);
        const results = { success: [], failed: [] };

        // Get current user tags
        const currentTags = db.prepare(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `).all(guild_id, user_id);

        const currentTagSlugs = currentTags.map(t => t.tag_slug);
        const newTags = tag_slugs.filter(slug => !currentTagSlugs.includes(slug));

        if (newTags.length === 0) {
            return { success: [], failed: tag_slugs };
        }

        // Check if adding all new tags would exceed limit
        const maxTags = cfg.max_tags_per_user || 30;
        const totalAfterAdd = currentTagSlugs.length + newTags.length;
        if (totalAfterAdd > maxTags) {
            const canAdd = maxTags - currentTagSlugs.length;
            if (canAdd <= 0) {
                return { success: [], failed: newTags };
            }
            newTags.splice(canAdd);
        }

        // Process each tag
        for (const tag_slug of newTags) {
            try {
                // Check if tag exists, create if allowed
                const tagExists = db.prepare(`
                    SELECT 1 FROM tags WHERE guild_id = ? AND tag_slug = ?
                `).get(guild_id, tag_slug);

                if (!tagExists) {
                    if (!cfg.allow_ugc_tags) {
                        results.failed.push(tag_slug);
                        continue;
                    }

                    const createTag = db.prepare(`
                        INSERT INTO tags (guild_id, tag_slug, display_name, created_by, created_at)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    `);
                    createTag.run(guild_id, tag_slug, tagSlugToDisplay(tag_slug), user_id);
                }

                // Add user to tag
                const addMember = db.prepare(`
                    INSERT OR IGNORE INTO tag_members (guild_id, tag_slug, user_id, added_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                `);
                addMember.run(guild_id, tag_slug, user_id);

                results.success.push(tag_slug);
            } catch (error) {
                results.failed.push(tag_slug);
            }
        }

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);

        return results;
    } catch (error) {
        console.error('Error adding multiple user tags:', error);
        throw error;
    }
}

export async function removeUserTag(guild_id, user_id, tag_slug) {
    try {
        // Remove from tag_members
        const removeMember = db.prepare(`
            DELETE FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ? AND user_id = ?
        `);
        removeMember.run(guild_id, tag_slug, user_id);

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);
    } catch (error) {
        console.error('Error removing user tag:', error);
        throw error;
    }
}

export async function removeMultipleUserTags(guild_id, user_id, tag_slugs) {
    try {
        const results = { success: [], failed: [] };

        // Get current user tags
        const currentTags = db.prepare(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `).all(guild_id, user_id);

        const currentTagSlugs = currentTags.map(t => t.tag_slug);
        const existingTags = tag_slugs.filter(slug => currentTagSlugs.includes(slug));

        if (existingTags.length === 0) {
            return { success: [], failed: tag_slugs };
        }

        // Process each tag
        for (const tag_slug of existingTags) {
            try {
                const removeMember = db.prepare(`
                    DELETE FROM tag_members 
                    WHERE guild_id = ? AND tag_slug = ? AND user_id = ?
                `);
                removeMember.run(guild_id, tag_slug, user_id);

                results.success.push(tag_slug);
            } catch (error) {
                results.failed.push(tag_slug);
            }
        }

        // Add non-existing tags to failed
        const nonExistingTags = tag_slugs.filter(slug => !currentTagSlugs.includes(slug));
        results.failed.push(...nonExistingTags);

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);

        return results;
    } catch (error) {
        console.error('Error removing multiple user tags:', error);
        throw error;
    }
}

export async function listUserTags(guild_id, user_id) {
    try {
        const stmt = db.prepare(`
            SELECT t.tag_slug, t.display_name, t.category 
            FROM tag_members tm
            JOIN tags t ON tm.guild_id = t.guild_id AND tm.tag_slug = t.tag_slug
            WHERE tm.guild_id = ? AND tm.user_id = ?
            ORDER BY t.display_name
        `);
        const rows = stmt.all(guild_id, user_id);

        return rows.map(row => ({
            tag_slug: row.tag_slug,
            display_name: row.display_name,
            category: row.category || 'general'
        }));
    } catch (error) {
        console.error('Error listing user tags:', error);
        throw error;
    }
}

export async function getUsersByTag(guild_id, tag_slug, limit = 5000, offset = 0) {
    try {
        const stmt = db.prepare(`
            SELECT user_id FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ?
            ORDER BY added_at
            LIMIT ? OFFSET ?
        `);
        const rows = stmt.all(guild_id, tag_slug, limit, offset);

        return rows.map(row => ({ user_id: row.user_id }));
    } catch (error) {
        console.error('Error getting users by tag:', error);
        throw error;
    }
}

// User theme management
export async function setUserTheme(guild_id, user_id, themeData) {
    try {
        const updates = [];
        const values = [];

        Object.entries(themeData).forEach(([key, value]) => {
            if (value !== undefined) {
                updates.push(`${key} = ?`);
                values.push(value);
            }
        });

        if (updates.length === 0) return;

        values.push(guild_id, user_id);

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO user_themes (guild_id, user_id, ${Object.keys(themeData).join(', ')}, updated_at)
            VALUES (?, ?, ${Object.keys(themeData).map(() => '?').join(', ')}, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id, user_id, ...Object.values(themeData));
    } catch (error) {
        console.error('Error setting user theme:', error);
        throw error;
    }
}

export async function getUserTheme(guild_id, user_id) {
    try {
        const stmt = db.prepare(`
            SELECT theme, primary_color, secondary_color, title, tags_emoji 
            FROM user_themes 
            WHERE guild_id = ? AND user_id = ?
        `);
        const row = stmt.get(guild_id, user_id);

        return row || null;
    } catch (error) {
        console.error('Error getting user theme:', error);
        throw error;
    }
}

// Mod config for new features
export async function setGuildFeatureConfig(guild_id, feature, enabled) {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO feature_configs (guild_id, ${feature}, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(guild_id, enabled);
    } catch (error) {
        console.error('Error setting guild feature config:', error);
        throw error;
    }
}

export async function getGuildFeatureConfig(guild_id) {
    try {
        const stmt = db.prepare(`
            SELECT ping_threads, user_customization 
            FROM feature_configs 
            WHERE guild_id = ?
        `);
        const row = stmt.get(guild_id);

        return row || {
            ping_threads: true,
            user_customization: true
        };
    } catch (error) {
        console.error('Error getting guild feature config:', error);
        throw error;
    }
}

// Helper function to update profile tags array
async function updateProfileTags(guild_id, user_id) {
    try {
        const tags = db.prepare(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `).all(guild_id, user_id);

        const tagSlugs = tags.map(t => t.tag_slug);

        const stmt = db.prepare(`
            UPDATE profiles 
            SET tags = ?, updated_at = CURRENT_TIMESTAMP
            WHERE guild_id = ? AND user_id = ?
        `);
        stmt.run(JSON.stringify(tagSlugs), guild_id, user_id);
    } catch (error) {
        console.error('Error updating profile tags:', error);
        throw error;
    }
}

function tagSlugToDisplay(slug) {
    return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Graceful shutdown
process.on('SIGINT', () => {
    db.close();
    console.log('Database connection closed.');
    process.exit(0);
});