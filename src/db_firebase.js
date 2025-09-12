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

function gref(guild_id) {
    return db.collection('guilds').doc(guild_id);
}

// ---- Guild bootstrap ----
export async function upsertGuild(guild_id) {
    const ref = gref(guild_id);
    await ref.set({ created_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// ---- Profiles ----
export async function upsertProfile(guild_id, user_id, bio = '', profile_image = null) {
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
}

export async function getProfile(guild_id, user_id) {
    const snap = await gref(guild_id).collection('profiles').doc(user_id).get();
    return snap.exists ? snap.data() : null;
}

// ---- Guild config ----
export async function getGuildConfig(guild_id) {
    const snap = await gref(guild_id).get();
    const data = snap.exists ? snap.data() : {};

    // Use explicit checks instead of nullish coalescing
    const allowUgc = data.allow_ugc_tags !== undefined ? data.allow_ugc_tags : true;
    const maxTags = data.max_tags_per_user !== undefined ? data.max_tags_per_user : 30;
    const theme = data.profile_theme || 'default';
    const colors = data.custom_colors || null;

    return {
        allow_ugc_tags: allowUgc,
        max_tags_per_user: maxTags,
        profile_theme: theme,
        custom_colors: colors,
    };
}

export async function setGuildConfig(guild_id, patch) {
    await gref(guild_id).set({...patch, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// ---- Tags (dictionary) ----
export async function addGuildTag(guild_id, tag_slug, display_name, created_by, category = 'general') {
    await gref(guild_id).collection('tags').doc(tag_slug).set({
        display_name,
        created_by,
        category,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
}

export async function removeGuildTag(guild_id, tag_slug) {
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
}

export async function listGuildTags(guild_id) {
    const q = await gref(guild_id).collection('tags').orderBy('display_name').get();
    return q.docs.map((d) => ({
        tag_slug: d.id,
        display_name: d.get('display_name'),
        category: d.get('category') || 'general'
    }));
}

export async function searchGuildTags(guild_id, qstr, limit = 25) {
    const all = await gref(guild_id).collection('tags').get();
    const rows = all.docs.map((d) => ({
        tag_slug: d.id,
        display_name: d.get('display_name') || d.id,
        category: d.get('category') || 'general'
    }));
    if (!qstr) return rows.slice(0, limit);
    const q = qstr.toLowerCase();
    return rows
        .filter((t) => (t.display_name || '').toLowerCase().includes(q) || t.tag_slug.includes(q))
        .slice(0, limit);
}

// ---- User tags (membership edges) ----
export async function addUserTag(guild_id, user_id, tag_slug) {
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

    await tagDoc.collection('members').doc(user_id).set({ added_at: admin.firestore.FieldValue.serverTimestamp() });
}

export async function addMultipleUserTags(guild_id, user_id, tag_slugs) {
    const cfg = await getGuildConfig(guild_id);
    const results = { success: [], failed: [] };

    // Get current user tags to check limits
    const pref = gref(guild_id).collection('profiles').doc(user_id);
    const currentSnap = await pref.get();
    const currentTags = (currentSnap.exists && Array.isArray(currentSnap.data().tags)) ? currentSnap.data().tags : [];

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

            // Add to tag's members collection
            await tagDoc.collection('members').doc(user_id).set({ added_at: admin.firestore.FieldValue.serverTimestamp() });

            results.success.push(tag_slug);
        } catch (error) {
            results.failed.push(tag_slug);
        }
    }

    return results;
}

export async function removeUserTag(guild_id, user_id, tag_slug) {
    const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
    await tagDoc.collection('members').doc(user_id).delete();

    const pref = gref(guild_id).collection('profiles').doc(user_id);
    await db.runTransaction(async(tx) => {
        const snap = await tx.get(pref);
        if (!snap.exists) return;
        const tags = Array.isArray(snap.data().tags) ? snap.data().tags : [];
        const next = tags.filter((t) => t !== tag_slug);
        tx.set(pref, { tags: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
}

export async function removeMultipleUserTags(guild_id, user_id, tag_slugs) {
    const results = { success: [], failed: [] };

    // Get current user tags to check what exists
    const pref = gref(guild_id).collection('profiles').doc(user_id);
    const currentSnap = await pref.get();
    const currentTags = (currentSnap.exists && Array.isArray(currentSnap.data().tags)) ? currentSnap.data().tags : [];

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

            // Remove from user's profile
            await db.runTransaction(async(tx) => {
                const snap = await tx.get(pref);
                if (!snap.exists) return;
                const tags = Array.isArray(snap.data().tags) ? snap.data().tags : [];
                const next = tags.filter((t) => t !== tag_slug);
                tx.set(pref, { tags: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            });

            results.success.push(tag_slug);
        } catch (error) {
            results.failed.push(tag_slug);
        }
    }

    // Add non-existing tags to failed
    const nonExistingTags = tag_slugs.filter(slug => !currentTags.includes(slug));
    results.failed.push(...nonExistingTags);

    return results;
}

export async function listUserTags(guild_id, user_id) {
    const pref = await gref(guild_id).collection('profiles').doc(user_id).get();
    const slugs = (pref.exists && Array.isArray(pref.data().tags)) ? pref.data().tags : [];
    if (!slugs.length) return [];
    const tagRefs = slugs.map((slug) => gref(guild_id).collection('tags').doc(slug));
    const snaps = await db.getAll(...tagRefs);
    return snaps.map((s, i) => ({
        tag_slug: slugs[i],
        display_name: s.exists ? (s.get('display_name') || tagSlugToDisplay(slugs[i])) : tagSlugToDisplay(slugs[i]),
        category: s.exists ? (s.get('category') || 'general') : 'general'
    }));
}

export async function getUsersByTag(guild_id, tag_slug, limit = 5000, offset = 0) {
    const membersSnap = await gref(guild_id).collection('tags').doc(tag_slug).collection('members').get();
    const ids = membersSnap.docs.map((d) => d.id);
    const sliced = ids.slice(offset, offset + limit);
    return sliced.map((user_id) => ({ user_id }));
}

function tagSlugToDisplay(slug) {
    return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}