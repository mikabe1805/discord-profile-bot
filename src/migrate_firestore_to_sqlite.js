import 'dotenv/config';
import admin from 'firebase-admin';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase (temporarily for migration)
const app = admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
});
const firestore = admin.firestore();

// Initialize SQLite
const dbPath = path.join(__dirname, '..', 'data', 'bot.db');
const db = new sqlite3.Database(dbPath);

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

async function migrateData() {
    try {
        console.log('🔄 Starting Firestore to SQLite migration...');

        // Get all guilds from Firestore
        const guildsSnapshot = await firestore.collection('guilds').get();
        console.log(`📊 Found ${guildsSnapshot.docs.length} guilds to migrate`);

        for (const guildDoc of guildsSnapshot.docs) {
            const guildId = guildDoc.id;
            const guildData = guildDoc.data();

            console.log(`🏰 Migrating guild: ${guildId}`);

            // Migrate guild data
            await dbRun(`
                INSERT OR REPLACE INTO guilds (
                    guild_id, created_at, allow_ugc_tags, max_tags_per_user, 
                    profile_theme, custom_colors, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                guildId,
                guildData.created_at ? .toDate ? .() || new Date(),
                guildData.allow_ugc_tags !== undefined ? guildData.allow_ugc_tags : 1,
                guildData.max_tags_per_user || 30,
                guildData.profile_theme || 'default',
                guildData.custom_colors ? JSON.stringify(guildData.custom_colors) : null,
                guildData.updated_at ? .toDate ? .() || new Date()
            ]);

            // Migrate profiles
            const profilesSnapshot = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('profiles')
                .get();

            console.log(`  👤 Migrating ${profilesSnapshot.docs.length} profiles`);

            for (const profileDoc of profilesSnapshot.docs) {
                const userId = profileDoc.id;
                const profileData = profileDoc.data();

                await dbRun(`
                    INSERT OR REPLACE INTO profiles (
                        guild_id, user_id, bio, profile_image, tags, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    guildId,
                    userId,
                    profileData.bio || '',
                    profileData.profile_image || null,
                    JSON.stringify(profileData.tags || []),
                    profileData.updated_at ? .toDate ? .() || new Date()
                ]);
            }

            // Migrate tags
            const tagsSnapshot = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('tags')
                .get();

            console.log(`  🏷️ Migrating ${tagsSnapshot.docs.length} tags`);

            for (const tagDoc of tagsSnapshot.docs) {
                const tagSlug = tagDoc.id;
                const tagData = tagDoc.data();

                await dbRun(`
                    INSERT OR REPLACE INTO tags (
                        guild_id, tag_slug, display_name, created_by, category, 
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    guildId,
                    tagSlug,
                    tagData.display_name,
                    tagData.created_by,
                    tagData.category || 'general',
                    tagData.created_at ? .toDate ? .() || new Date(),
                    tagData.updated_at ? .toDate ? .() || new Date()
                ]);

                // Migrate tag members
                const membersSnapshot = await firestore
                    .collection('guilds')
                    .doc(guildId)
                    .collection('tags')
                    .doc(tagSlug)
                    .collection('members')
                    .get();

                for (const memberDoc of membersSnapshot.docs) {
                    const userId = memberDoc.id;
                    const memberData = memberDoc.data();

                    await dbRun(`
                        INSERT OR REPLACE INTO tag_members (
                            guild_id, tag_slug, user_id, added_at
                        ) VALUES (?, ?, ?, ?)
                    `, [
                        guildId,
                        tagSlug,
                        userId,
                        memberData.added_at ? .toDate ? .() || new Date()
                    ]);
                }
            }

            // Migrate user themes
            const themesSnapshot = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('user_themes')
                .get();

            console.log(`  🎨 Migrating ${themesSnapshot.docs.length} user themes`);

            for (const themeDoc of themesSnapshot.docs) {
                const userId = themeDoc.id;
                const themeData = themeDoc.data();

                await dbRun(`
                    INSERT OR REPLACE INTO user_themes (
                        guild_id, user_id, theme, primary_color, secondary_color, 
                        title, tags_emoji, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    guildId,
                    userId,
                    themeData.theme,
                    themeData.primary_color,
                    themeData.secondary_color,
                    themeData.title,
                    themeData.tags_emoji,
                    themeData.updated_at ? .toDate ? .() || new Date()
                ]);
            }

            // Migrate feature configs
            const featureConfigDoc = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('config')
                .doc('features')
                .get();

            if (featureConfigDoc.exists) {
                const featureData = featureConfigDoc.data();

                await dbRun(`
                    INSERT OR REPLACE INTO feature_configs (
                        guild_id, ping_threads, user_customization, updated_at
                    ) VALUES (?, ?, ?, ?)
                `, [
                    guildId,
                    featureData.ping_threads !== undefined ? featureData.ping_threads : 1,
                    featureData.user_customization !== undefined ? featureData.user_customization : 1,
                    featureData.updated_at ? .toDate ? .() || new Date()
                ]);
            }
        }

        console.log('✅ Migration completed successfully!');
        console.log('📁 Your data is now stored in: data/bot.db');

    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        // Close connections
        await new Promise(resolve => db.close(resolve));
        process.exit(0);
    }
}

// Run migration
migrateData();