import 'dotenv/config';
import admin from 'firebase-admin';

const app = admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
});
const db = admin.firestore();

// In-memory cache to reduce Firestore reads
const cache = {
    guildConfigs: new Map(),
    profiles: new Map(),
    tags: new Map(),
    userThemes: new Map(),
    featureConfigs: new Map(),
    lastCleanup: Date.now()
};

// Cache TTL (Time To Live) in milliseconds
const CACHE_TTL = {
    guildConfig: 5 * 60 * 1000, // 5 minutes
    profile: 2 * 60 * 1000, // 2 minutes
    tags: 10 * 60 * 1000, // 10 minutes
    userTheme: 5 * 60 * 1000, // 5 minutes
    featureConfig: 10 * 60 * 1000 // 10 minutes
};

// Usage tracking
const usageStats = {
    reads: 0,
    writes: 0,
    cacheHits: 0,
    quotaErrors: 0,
    lastReset: Date.now()
};

// Cleanup cache every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.guildConfigs.entries()) {
        if (now - value.timestamp > CACHE_TTL.guildConfig) {
            cache.guildConfigs.delete(key);
        }
    }
    for (const [key, value] of cache.profiles.entries()) {
        if (now - value.timestamp > CACHE_TTL.profile) {
            cache.profiles.delete(key);
        }
    }
    for (const [key, value] of cache.tags.entries()) {
        if (now - value.timestamp > CACHE_TTL.tags) {
            cache.tags.delete(key);
        }
    }
    for (const [key, value] of cache.userThemes.entries()) {
        if (now - value.timestamp > CACHE_TTL.userTheme) {
            cache.userThemes.delete(key);
        }
    }
    for (const [key, value] of cache.featureConfigs.entries()) {
        if (now - value.timestamp > CACHE_TTL.featureConfig) {
            cache.featureConfigs.delete(key);
        }
    }
}, 5 * 60 * 1000);

// Reset stats every hour
setInterval(() => {
    const now = Date.now();
    const hoursSinceReset = (now - usageStats.lastReset) / (1000 * 60 * 60);
    if (hoursSinceReset >= 1) {
        console.log(`Firestore usage in last hour - Reads: ${usageStats.reads}, Writes: ${usageStats.writes}, Cache hits: ${usageStats.cacheHits}, Quota errors: ${usageStats.quotaErrors}`);
        usageStats.reads = 0;
        usageStats.writes = 0;
        usageStats.cacheHits = 0;
        usageStats.quotaErrors = 0;
        usageStats.lastReset = now;
    }
}, 5 * 60 * 1000); // Check every 5 minutes

// Retry logic for quota exceeded errors
async function withRetry(operation, maxRetries = 3, baseDelay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (error.code === 8 && error.details === 'Quota exceeded.') {
                usageStats.quotaErrors++;
                if (attempt === maxRetries) {
                    console.error(`Firestore quota exceeded after ${maxRetries} attempts:`, error);
                    console.error(`Current usage stats - Reads: ${usageStats.reads}, Writes: ${usageStats.writes}, Cache hits: ${usageStats.cacheHits}`);
                    throw new Error('Database quota exceeded. Please try again later.');
                }
                // Exponential backoff with jitter
                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
                console.warn(`Quota exceeded, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}

function gref(guild_id) {
    return db.collection('guilds').doc(guild_id);
}

// ---- Guild bootstrap ----
export async function upsertGuild(guild_id) {
    return withRetry(async() => {
        const ref = gref(guild_id);
        await ref.set({ created_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        usageStats.writes++;
    });
}

// ---- Profiles ----
export async function upsertProfile(guild_id, user_id, bio = '', profile_image = null) {
    return withRetry(async() => {
        const pref = gref(guild_id).collection('profiles').doc(user_id);
        const bioValue = bio || '';
        const updateData = {
            bio: bioValue,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (profile_image) {
            updateData.profile_image = profile_image;
        }

        await pref.set(updateData, { merge: true });
        usageStats.writes++;

        // Invalidate cache
        const cacheKey = `${guild_id}:${user_id}`;
        cache.profiles.delete(cacheKey);
    });
}

export async function getProfile(guild_id, user_id) {
    const cacheKey = `${guild_id}:${user_id}`;
    const cached = cache.profiles.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.profile) {
        usageStats.cacheHits++;
        return cached.data;
    }

    return withRetry(async() => {
        const snap = await gref(guild_id).collection('profiles').doc(user_id).get();
        const data = snap.exists ? snap.data() : null;
        usageStats.reads++;

        // Cache the result
        cache.profiles.set(cacheKey, {
            data,
            timestamp: Date.now()
        });

        return data;
    });
}

// ---- Guild config ----
export async function getGuildConfig(guild_id) {
    const cached = cache.guildConfigs.get(guild_id);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.guildConfig) {
        usageStats.cacheHits++;
        return cached.data;
    }

    return withRetry(async() => {
        const snap = await gref(guild_id).get();
        const data = snap.exists ? snap.data() : {};
        usageStats.reads++;

        // Use explicit checks instead of nullish coalescing
        const allowUgc = data.allow_ugc_tags !== undefined ? data.allow_ugc_tags : true;
        const maxTags = data.max_tags_per_user !== undefined ? data.max_tags_per_user : 30;
        const theme = data.profile_theme || 'default';
        const colors = data.custom_colors || null;

        const config = {
            allow_ugc_tags: allowUgc,
            max_tags_per_user: maxTags,
            profile_theme: theme,
            custom_colors: colors,
        };

        // Cache the result
        cache.guildConfigs.set(guild_id, {
            data: config,
            timestamp: Date.now()
        });

        return config;
    });
}

export async function setGuildConfig(guild_id, patch) {
    return withRetry(async() => {
        await gref(guild_id).set({...patch, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        usageStats.writes++;

        // Invalidate cache
        cache.guildConfigs.delete(guild_id);
    });
}

// ---- Tags (dictionary) ----
export async function addGuildTag(guild_id, tag_slug, display_name, created_by, category = 'general') {
    return withRetry(async() => {
        await gref(guild_id).collection('tags').doc(tag_slug).set({
            display_name,
            created_by,
            category,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        usageStats.writes++;

        // Invalidate tags cache
        cache.tags.delete(`${guild_id}:tags`);
    });
}

export async function removeGuildTag(guild_id, tag_slug) {
    return withRetry(async() => {
        const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
        const members = await tagDoc.collection('members').listDocuments();
        const batches = [];
        while (members.length) {
            const chunk = members.splice(0, 400);
            const b = db.batch();
            chunk.forEach((d) => b.delete(d));
            batches.push(b.commit());
        }
        await Promise.all(batches);
        await tagDoc.delete();
        usageStats.writes += members.length + 1;

        // Invalidate tags cache
        cache.tags.delete(`${guild_id}:tags`);
    });
}

export async function listGuildTags(guild_id) {
    const cacheKey = `${guild_id}:tags`;
    const cached = cache.tags.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.tags) {
        usageStats.cacheHits++;
        return cached.data;
    }

    return withRetry(async() => {
        const q = await gref(guild_id).collection('tags').orderBy('display_name').get();
        const result = q.docs.map((d) => ({
            tag_slug: d.id,
            display_name: d.get('display_name'),
            category: d.get('category') || 'general'
        }));
        usageStats.reads++;

        // Cache the result
        cache.tags.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        return result;
    });
}

export async function searchGuildTags(guild_id, qstr, limit = 25) {
    const cacheKey = `${guild_id}:tags`;
    const cached = cache.tags.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.tags) {
        usageStats.cacheHits++;
        const rows = cached.data;
        if (!qstr) return rows.slice(0, limit);
        const q = qstr.toLowerCase();
        return rows
            .filter((t) => (t.display_name || '').toLowerCase().includes(q) || t.tag_slug.includes(q))
            .slice(0, limit);
    }

    return withRetry(async() => {
        // Use a more efficient query - only get what we need
        let query = gref(guild_id).collection('tags').orderBy('display_name').limit(100);

        // If we have a search string, we still need to get all tags for filtering
        // but we can limit the initial fetch
        const all = await query.get();
        const rows = all.docs.map((d) => ({
            tag_slug: d.id,
            display_name: d.get('display_name') || d.id,
            category: d.get('category') || 'general'
        }));
        usageStats.reads++;

        // Cache the result
        cache.tags.set(cacheKey, {
            data: rows,
            timestamp: Date.now()
        });

        if (!qstr) return rows.slice(0, limit);
        const q = qstr.toLowerCase();
        return rows
            .filter((t) => (t.display_name || '').toLowerCase().includes(q) || t.tag_slug.includes(q))
            .slice(0, limit);
    });
}

// ---- User tags (membership edges) ----
export async function addUserTag(guild_id, user_id, tag_slug) {
    return withRetry(async() => {
        const cfg = await getGuildConfig(guild_id);

        // Ensure tag exists or allowed to create
        const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
        const tagSnap = await tagDoc.get();
        if (!tagSnap.exists) {
            if (!cfg.allow_ugc_tags) {
                const e = new Error('UGC tags are disabled in this server.');
                e.code = 'UGC_DISABLED';
                throw e;
            }
            await tagDoc.set({
                display_name: tagSlugToDisplay(tag_slug),
                created_by: user_id,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            usageStats.writes++;

            // Invalidate tags cache
            cache.tags.delete(`${guild_id}:tags`);
        }

        // Enforce max tags per user
        const pref = gref(guild_id).collection('profiles').doc(user_id);
        const maxTags = cfg.max_tags_per_user || 30;
        await db.runTransaction(async(tx) => {
            const snap = await tx.get(pref);
            const tags = (snap.exists && Array.isArray(snap.data().tags)) ? snap.data().tags : [];
            if (!tags.includes(tag_slug)) {
                if (tags.length >= maxTags) {
                    const e = new Error(`Max tags per user reached (${cfg.max_tags_per_user}).`);
                    e.code = 'LIMIT_REACHED';
                    throw e;
                }
                tags.push(tag_slug);
            }
            tx.set(pref, { tags, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        usageStats.reads++;
        usageStats.writes++;

        await tagDoc.collection('members').doc(user_id).set({ added_at: admin.firestore.FieldValue.serverTimestamp() });
        usageStats.writes++;

        // Invalidate profile cache
        const profileCacheKey = `${guild_id}:${user_id}`;
        cache.profiles.delete(profileCacheKey);
    });
}

export async function addMultipleUserTags(guild_id, user_id, tag_slugs) {
    return withRetry(async() => {
        const cfg = await getGuildConfig(guild_id);
        const results = { success: [], failed: [] };

        // Get current user tags to check limits
        const pref = gref(guild_id).collection('profiles').doc(user_id);
        const currentSnap = await pref.get();
        const currentTags = (currentSnap.exists && Array.isArray(currentSnap.data().tags)) ? currentSnap.data().tags : [];
        usageStats.reads++;

        // Filter out tags that already exist
        const newTags = tag_slugs.filter(slug => !currentTags.includes(slug));

        if (newTags.length === 0) {
            return { success: [], failed: tag_slugs };
        }

        // Check if adding all new tags would exceed limit
        const maxTags = cfg.max_tags_per_user || 30;
        const totalAfterAdd = currentTags.length + newTags.length;
        if (totalAfterAdd > maxTags) {
            const canAdd = maxTags - currentTags.length;
            if (canAdd <= 0) {
                return { success: [], failed: newTags };
            }
            // Only process the tags that can be added
            newTags.splice(canAdd);
        }

        // Process each tag
        for (const tag_slug of newTags) {
            try {
                // Ensure tag exists or allowed to create
                const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
                const tagSnap = await tagDoc.get();
                if (!tagSnap.exists) {
                    if (!cfg.allow_ugc_tags) {
                        results.failed.push(tag_slug);
                        continue;
                    }
                    await tagDoc.set({
                        display_name: tagSlugToDisplay(tag_slug),
                        created_by: user_id,
                        created_at: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    usageStats.writes++;

                    // Invalidate tags cache
                    cache.tags.delete(`${guild_id}:tags`);
                }

                // Add to user's profile
                await db.runTransaction(async(tx) => {
                    const snap = await tx.get(pref);
                    const tags = (snap.exists && Array.isArray(snap.data().tags)) ? snap.data().tags : [];
                    if (!tags.includes(tag_slug)) {
                        tags.push(tag_slug);
                    }
                    tx.set(pref, { tags, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                });
                usageStats.reads++;
                usageStats.writes++;

                // Add to tag's members collection
                await tagDoc.collection('members').doc(user_id).set({ added_at: admin.firestore.FieldValue.serverTimestamp() });
                usageStats.writes++;

                results.success.push(tag_slug);
            } catch (error) {
                results.failed.push(tag_slug);
            }
        }

        // Invalidate profile cache
        const profileCacheKey = `${guild_id}:${user_id}`;
        cache.profiles.delete(profileCacheKey);

        return results;
    });
}

export async function removeUserTag(guild_id, user_id, tag_slug) {
    return withRetry(async() => {
        const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
        await tagDoc.collection('members').doc(user_id).delete();
        usageStats.writes++;

        const pref = gref(guild_id).collection('profiles').doc(user_id);
        await db.runTransaction(async(tx) => {
            const snap = await tx.get(pref);
            if (!snap.exists) return;
            const tags = Array.isArray(snap.data().tags) ? snap.data().tags : [];
            const next = tags.filter((t) => t !== tag_slug);
            tx.set(pref, { tags: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        usageStats.reads++;
        usageStats.writes++;

        // Invalidate profile cache
        const profileCacheKey = `${guild_id}:${user_id}`;
        cache.profiles.delete(profileCacheKey);
    });
}

export async function removeMultipleUserTags(guild_id, user_id, tag_slugs) {
    return withRetry(async() => {
        const results = { success: [], failed: [] };

        // Get current user tags to check what exists
        const pref = gref(guild_id).collection('profiles').doc(user_id);
        const currentSnap = await pref.get();
        const currentTags = (currentSnap.exists && Array.isArray(currentSnap.data().tags)) ? currentSnap.data().tags : [];
        usageStats.reads++;

        // Filter to only tags that actually exist on the user
        const existingTags = tag_slugs.filter(slug => currentTags.includes(slug));

        if (existingTags.length === 0) {
            return { success: [], failed: tag_slugs };
        }

        // Process each tag
        for (const tag_slug of existingTags) {
            try {
                const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
                await tagDoc.collection('members').doc(user_id).delete();
                usageStats.writes++;

                // Remove from user's profile
                await db.runTransaction(async(tx) => {
                    const snap = await tx.get(pref);
                    if (!snap.exists) return;
                    const tags = Array.isArray(snap.data().tags) ? snap.data().tags : [];
                    const next = tags.filter((t) => t !== tag_slug);
                    tx.set(pref, { tags: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                });
                usageStats.reads++;
                usageStats.writes++;

                results.success.push(tag_slug);
            } catch (error) {
                results.failed.push(tag_slug);
            }
        }

        // Add non-existing tags to failed
        const nonExistingTags = tag_slugs.filter(slug => !currentTags.includes(slug));
        results.failed.push(...nonExistingTags);

        // Invalidate profile cache
        const profileCacheKey = `${guild_id}:${user_id}`;
        cache.profiles.delete(profileCacheKey);

        return results;
    });
}

export async function listUserTags(guild_id, user_id) {
    return withRetry(async() => {
        const pref = await gref(guild_id).collection('profiles').doc(user_id).get();
        const slugs = (pref.exists && Array.isArray(pref.data().tags)) ? pref.data().tags : [];
        if (!slugs.length) return [];
        const tagRefs = slugs.map((slug) => gref(guild_id).collection('tags').doc(slug));
        const snaps = await db.getAll(...tagRefs);
        usageStats.reads += 1 + slugs.length;
        return snaps.map((s, i) => ({
            tag_slug: slugs[i],
            display_name: s.exists ? (s.get('display_name') || tagSlugToDisplay(slugs[i])) : tagSlugToDisplay(slugs[i]),
            category: s.exists ? (s.get('category') || 'general') : 'general'
        }));
    });
}

export async function getUsersByTag(guild_id, tag_slug, limit = 5000, offset = 0) {
    return withRetry(async() => {
        const membersSnap = await gref(guild_id).collection('tags').doc(tag_slug).collection('members').get();
        const ids = membersSnap.docs.map((d) => d.id);
        const sliced = ids.slice(offset, offset + limit);
        usageStats.reads++;
        return sliced.map((user_id) => ({ user_id }));
    });
}

function tagSlugToDisplay(slug) {
    return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// User theme management
export async function setUserTheme(guild_id, user_id, themeData) {
    return withRetry(async() => {
        const userDoc = gref(guild_id).collection('user_themes').doc(user_id);
        await userDoc.set({
            ...themeData,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        usageStats.writes++;

        // Invalidate cache
        const cacheKey = `${guild_id}:${user_id}`;
        cache.userThemes.delete(cacheKey);
    });
}

export async function getUserTheme(guild_id, user_id) {
    const cacheKey = `${guild_id}:${user_id}`;
    const cached = cache.userThemes.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.userTheme) {
        usageStats.cacheHits++;
        return cached.data;
    }

    return withRetry(async() => {
        const userDoc = gref(guild_id).collection('user_themes').doc(user_id);
        const snap = await userDoc.get();
        const data = snap.exists ? snap.data() : null;
        usageStats.reads++;

        // Cache the result
        cache.userThemes.set(cacheKey, {
            data,
            timestamp: Date.now()
        });

        return data;
    });
}

// Mod config for new features
export async function setGuildFeatureConfig(guild_id, feature, enabled) {
    return withRetry(async() => {
        const configDoc = gref(guild_id).collection('config').doc('features');
        await configDoc.set({
            [feature]: enabled,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        usageStats.writes++;

        // Invalidate cache
        cache.featureConfigs.delete(guild_id);
    });
}

export async function getGuildFeatureConfig(guild_id) {
    const cached = cache.featureConfigs.get(guild_id);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL.featureConfig) {
        usageStats.cacheHits++;
        return cached.data;
    }

    return withRetry(async() => {
        const configDoc = gref(guild_id).collection('config').doc('features');
        const snap = await configDoc.get();
        const data = snap.exists ? snap.data() : {
            ping_threads: true,
            user_customization: true
        };
        usageStats.reads++;

        // Cache the result
        cache.featureConfigs.set(guild_id, {
            data,
            timestamp: Date.now()
        });

        return data;
    });
}