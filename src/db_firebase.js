import 'dotenv/config';
import admin from 'firebase-admin';

const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Handle escaped newlines in env
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
  await ref.set(
    { created_at: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ---- Profiles ----
export async function upsertProfile(guild_id, user_id, bio = '') {
  const pref = gref(guild_id).collection('profiles').doc(user_id);
  await pref.set(
    {
      bio: bio ?? '',
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function getProfile(guild_id, user_id) {
  const snap = await gref(guild_id).collection('profiles').doc(user_id).get();
  return snap.exists ? snap.data() : null;
}

// ---- Tags (dictionary) ----
export async function addGuildTag(guild_id, tag_slug, display_name, created_by) {
  await gref(guild_id).collection('tags').doc(tag_slug).set(
    {
      display_name,
      created_by,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function removeGuildTag(guild_id, tag_slug) {
  const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
  // delete members subcollection (batch)
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
  return q.docs.map((d) => ({ tag_slug: d.id, display_name: d.get('display_name') }));
}

export async function searchGuildTags(guild_id, qstr, limit = 25) {
  const all = await gref(guild_id).collection('tags').get();
  const rows = all.docs.map((d) => ({ tag_slug: d.id, display_name: d.get('display_name') || d.id }));
  if (!qstr) return rows.slice(0, limit);
  const q = qstr.toLowerCase();
  return rows
    .filter((t) => (t.display_name || '').toLowerCase().includes(q) || t.tag_slug.includes(q))
    .slice(0, limit);
}

// ---- User tags (membership edges) ----
export async function addUserTag(guild_id, user_id, tag_slug) {
  // Ensure tag doc exists (UGC allowed)
  const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
  const tagSnap = await tagDoc.get();
  if (!tagSnap.exists) {
    await tagDoc.set({
      display_name: tagSlugToDisplay(tag_slug),
      created_by: user_id,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  // Add membership
  await tagDoc.collection('members').doc(user_id).set({ added_at: admin.firestore.FieldValue.serverTimestamp() });

  // Mirror into profile.tags (optional but useful for quick display)
  const pref = gref(guild_id).collection('profiles').doc(user_id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pref);
    const tags = (snap.exists && Array.isArray(snap.data().tags)) ? snap.data().tags : [];
    if (!tags.includes(tag_slug)) {
      tags.push(tag_slug);
      tx.set(pref, { tags, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  });
}

export async function removeUserTag(guild_id, user_id, tag_slug) {
  const tagDoc = gref(guild_id).collection('tags').doc(tag_slug);
  await tagDoc.collection('members').doc(user_id).delete();

  const pref = gref(guild_id).collection('profiles').doc(user_id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pref);
    if (!snap.exists) return;
    const tags = Array.isArray(snap.data().tags) ? snap.data().tags : [];
    const next = tags.filter((t) => t !== tag_slug);
    tx.set(pref, { tags: next, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}

export async function listUserTags(guild_id, user_id) {
  const pref = await gref(guild_id).collection('profiles').doc(user_id).get();
  const slugs = (pref.exists && Array.isArray(pref.data().tags)) ? pref.data().tags : [];
  if (!slugs.length) return [];
  // Map slugs -> display names
  const tagRefs = slugs.map((slug) => gref(guild_id).collection('tags').doc(slug));
  const snaps = await db.getAll(...tagRefs);
  return snaps.map((s, i) => ({
    tag_slug: slugs[i],
    display_name: s.exists ? (s.get('display_name') || tagSlugToDisplay(slugs[i])) : tagSlugToDisplay(slugs[i]),
  }));
}

export async function getUsersByTag(guild_id, tag_slug, limit = 5000, offset = 0) {
  // No offset in Firestore; we’ll just read and slice (fine at small scale).
  const membersSnap = await gref(guild_id).collection('tags').doc(tag_slug).collection('members').get();
  const ids = membersSnap.docs.map((d) => d.id);
  const sliced = ids.slice(offset, offset + limit);
  return sliced.map((user_id) => ({ user_id }));
}

function tagSlugToDisplay(slug) {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
