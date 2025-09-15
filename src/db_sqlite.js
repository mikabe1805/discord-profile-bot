import 'dotenv/config';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize SQL.js
let SQL = null;
let db = null;

// Initialize database
async function initDatabase() {
    try {
        SQL = await initSqlJs();

        // Create data directory if it doesn't exist
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const dbPath = path.join(dataDir, 'bot.db');

        // Load existing database or create new one
        if (fs.existsSync(dbPath)) {
            const filebuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(filebuffer);
        } else {
            db = new SQL.Database();
        }

        // Create tables
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

        // Save the database
        saveDatabase();

        console.log('✅ SQLite database initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
        throw error;
    }
}

// Save database to file
function saveDatabase() {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        const dbPath = path.join(__dirname, '..', 'data', 'bot.db');
        fs.writeFileSync(dbPath, buffer);
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

// Helper function to execute query and return results
function executeQuery(query, params = []) {
    try {
        const stmt = db.prepare(query);
        const results = [];

        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }

        stmt.free();
        return results;
    } catch (error) {
        console.error('Query execution error:', error);
        throw error;
    }
}

// Helper function to execute query and return single result
function executeQuerySingle(query, params = []) {
    try {
        const stmt = db.prepare(query);
        let result = null;

        if (stmt.step()) {
            result = stmt.getAsObject();
        }

        stmt.free();
        return result;
    } catch (error) {
        console.error('Query execution error:', error);
        throw error;
    }
}

// Helper function to execute query without returning results
function executeQueryRun(query, params = []) {
    try {
        const stmt = db.prepare(query);
        stmt.run(params);
        stmt.free();
    } catch (error) {
        console.error('Query execution error:', error);
        throw error;
    }
}

// Initialize database on import
await initDatabase();

// ---- Guild bootstrap ----
export async function upsertGuild(guild_id) {
    try {
        executeQueryRun(`
            INSERT OR IGNORE INTO guilds (guild_id, created_at) 
            VALUES (?, CURRENT_TIMESTAMP)
        `, [guild_id]);
        saveDatabase();
    } catch (error) {
        console.error('Error upserting guild:', error);
        throw error;
    }
}

// ---- Profiles ----
export async function upsertProfile(guild_id, user_id, bio = '', profile_image = null) {
    try {
        executeQueryRun(`
            INSERT OR REPLACE INTO profiles (guild_id, user_id, bio, profile_image, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [guild_id, user_id, bio, profile_image]);
        saveDatabase();
    } catch (error) {
        console.error('Error upserting profile:', error);
        throw error;
    }
}

export async function getProfile(guild_id, user_id) {
    try {
        const result = executeQuerySingle(`
            SELECT bio, profile_image, tags FROM profiles 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

        if (!result) return null;

        return {
            bio: result.bio,
            profile_image: result.profile_image,
            tags: JSON.parse(result.tags || '[]')
        };
    } catch (error) {
        console.error('Error getting profile:', error);
        throw error;
    }
}

// ---- Guild config ----
export async function getGuildConfig(guild_id) {
    try {
        const result = executeQuerySingle(`
            SELECT allow_ugc_tags, max_tags_per_user, profile_theme, custom_colors 
            FROM guilds WHERE guild_id = ?
        `, [guild_id]);

        if (!result) {
            // Return defaults if guild doesn't exist
            return {
                allow_ugc_tags: true,
                max_tags_per_user: 30,
                profile_theme: 'default',
                custom_colors: null
            };
        }

        return {
            allow_ugc_tags: Boolean(result.allow_ugc_tags),
            max_tags_per_user: result.max_tags_per_user || 30,
            profile_theme: result.profile_theme || 'default',
            custom_colors: result.custom_colors ? JSON.parse(result.custom_colors) : null
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

        executeQueryRun(`
            INSERT OR REPLACE INTO guilds (guild_id, ${Object.keys(patch).join(', ')}, updated_at)
            VALUES (?, ${Object.keys(patch).map(() => '?').join(', ')}, CURRENT_TIMESTAMP)
        `, [guild_id, ...Object.values(patch)]);
        saveDatabase();
    } catch (error) {
        console.error('Error setting guild config:', error);
        throw error;
    }
}

// ---- Tags (dictionary) ----
export async function addGuildTag(guild_id, tag_slug, display_name, created_by, category = 'general') {
    try {
        executeQueryRun(`
            INSERT OR REPLACE INTO tags (guild_id, tag_slug, display_name, created_by, category, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [guild_id, tag_slug, display_name, created_by, category]);
        saveDatabase();
    } catch (error) {
        console.error('Error adding guild tag:', error);
        throw error;
    }
}

export async function removeGuildTag(guild_id, tag_slug) {
    try {
        // Remove all members first
        executeQueryRun(`
            DELETE FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ?
        `, [guild_id, tag_slug]);

        // Remove the tag
        executeQueryRun(`
            DELETE FROM tags 
            WHERE guild_id = ? AND tag_slug = ?
        `, [guild_id, tag_slug]);
        saveDatabase();
    } catch (error) {
        console.error('Error removing guild tag:', error);
        throw error;
    }
}

export async function listGuildTags(guild_id) {
    try {
        const results = executeQuery(`
            SELECT tag_slug, display_name, category 
            FROM tags 
            WHERE guild_id = ? 
            ORDER BY display_name
        `, [guild_id]);

        return results.map(row => ({
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

        const results = executeQuery(query, params);

        return results.map(row => ({
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
        const tagExists = executeQuerySingle(`
            SELECT 1 FROM tags WHERE guild_id = ? AND tag_slug = ?
        `, [guild_id, tag_slug]);

        if (!tagExists) {
            if (!cfg.allow_ugc_tags) {
                const e = new Error('UGC tags are disabled in this server.');
                e.code = 'UGC_DISABLED';
                throw e;
            }

            executeQueryRun(`
                INSERT INTO tags (guild_id, tag_slug, display_name, created_by, created_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [guild_id, tag_slug, tagSlugToDisplay(tag_slug), user_id]);
        }

        // Check current tag count
        const currentTags = executeQuery(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

        if (currentTags.length >= cfg.max_tags_per_user) {
            const e = new Error(`Max tags per user reached (${cfg.max_tags_per_user}).`);
            e.code = 'LIMIT_REACHED';
            throw e;
        }

        // Add user to tag
        executeQueryRun(`
            INSERT OR IGNORE INTO tag_members (guild_id, tag_slug, user_id, added_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `, [guild_id, tag_slug, user_id]);

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);
        saveDatabase();
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
        const currentTags = executeQuery(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

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
                const tagExists = executeQuerySingle(`
                    SELECT 1 FROM tags WHERE guild_id = ? AND tag_slug = ?
                `, [guild_id, tag_slug]);

                if (!tagExists) {
                    if (!cfg.allow_ugc_tags) {
                        results.failed.push(tag_slug);
                        continue;
                    }

                    executeQueryRun(`
                        INSERT INTO tags (guild_id, tag_slug, display_name, created_by, created_at)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    `, [guild_id, tag_slug, tagSlugToDisplay(tag_slug), user_id]);
                }

                // Add user to tag
                executeQueryRun(`
                    INSERT OR IGNORE INTO tag_members (guild_id, tag_slug, user_id, added_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                `, [guild_id, tag_slug, user_id]);

                results.success.push(tag_slug);
            } catch (error) {
                results.failed.push(tag_slug);
            }
        }

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);
        saveDatabase();

        return results;
    } catch (error) {
        console.error('Error adding multiple user tags:', error);
        throw error;
    }
}

export async function removeUserTag(guild_id, user_id, tag_slug) {
    try {
        // Remove from tag_members
        executeQueryRun(`
            DELETE FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ? AND user_id = ?
        `, [guild_id, tag_slug, user_id]);

        // Update profile tags array
        await updateProfileTags(guild_id, user_id);
        saveDatabase();
    } catch (error) {
        console.error('Error removing user tag:', error);
        throw error;
    }
}

export async function removeMultipleUserTags(guild_id, user_id, tag_slugs) {
    try {
        const results = { success: [], failed: [] };

        // Get current user tags
        const currentTags = executeQuery(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

        const currentTagSlugs = currentTags.map(t => t.tag_slug);
        const existingTags = tag_slugs.filter(slug => currentTagSlugs.includes(slug));

        if (existingTags.length === 0) {
            return { success: [], failed: tag_slugs };
        }

        // Process each tag
        for (const tag_slug of existingTags) {
            try {
                executeQueryRun(`
                    DELETE FROM tag_members 
                    WHERE guild_id = ? AND tag_slug = ? AND user_id = ?
                `, [guild_id, tag_slug, user_id]);

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
        saveDatabase();

        return results;
    } catch (error) {
        console.error('Error removing multiple user tags:', error);
        throw error;
    }
}

export async function listUserTags(guild_id, user_id) {
    try {
        const results = executeQuery(`
            SELECT t.tag_slug, t.display_name, t.category 
            FROM tag_members tm
            JOIN tags t ON tm.guild_id = t.guild_id AND tm.tag_slug = t.tag_slug
            WHERE tm.guild_id = ? AND tm.user_id = ?
            ORDER BY t.display_name
        `, [guild_id, user_id]);

        return results.map(row => ({
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
        const results = executeQuery(`
            SELECT user_id FROM tag_members 
            WHERE guild_id = ? AND tag_slug = ?
            ORDER BY added_at
            LIMIT ? OFFSET ?
        `, [guild_id, tag_slug, limit, offset]);

        return results.map(row => ({ user_id: row.user_id }));
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

        executeQueryRun(`
            INSERT OR REPLACE INTO user_themes (guild_id, user_id, ${Object.keys(themeData).join(', ')}, updated_at)
            VALUES (?, ?, ${Object.keys(themeData).map(() => '?').join(', ')}, CURRENT_TIMESTAMP)
        `, [guild_id, user_id, ...Object.values(themeData)]);
        saveDatabase();
    } catch (error) {
        console.error('Error setting user theme:', error);
        throw error;
    }
}

export async function getUserTheme(guild_id, user_id) {
    try {
        const result = executeQuerySingle(`
            SELECT theme, primary_color, secondary_color, title, tags_emoji 
            FROM user_themes 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

        return result || null;
    } catch (error) {
        console.error('Error getting user theme:', error);
        throw error;
    }
}

// Mod config for new features
export async function setGuildFeatureConfig(guild_id, feature, enabled) {
    try {
        executeQueryRun(`
            INSERT OR REPLACE INTO feature_configs (guild_id, ${feature}, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `, [guild_id, enabled]);
        saveDatabase();
    } catch (error) {
        console.error('Error setting guild feature config:', error);
        throw error;
    }
}

export async function getGuildFeatureConfig(guild_id) {
    try {
        const result = executeQuerySingle(`
            SELECT ping_threads, user_customization 
            FROM feature_configs 
            WHERE guild_id = ?
        `, [guild_id]);

        return result || {
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
        const tags = executeQuery(`
            SELECT tag_slug FROM tag_members 
            WHERE guild_id = ? AND user_id = ?
        `, [guild_id, user_id]);

        const tagSlugs = tags.map(t => t.tag_slug);

        executeQueryRun(`
            UPDATE profiles 
            SET tags = ?, updated_at = CURRENT_TIMESTAMP
            WHERE guild_id = ? AND user_id = ?
        `, [JSON.stringify(tagSlugs), guild_id, user_id]);
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
    if (db) {
        saveDatabase();
        db.close();
        console.log('Database connection closed.');
    }
    process.exit(0);
});