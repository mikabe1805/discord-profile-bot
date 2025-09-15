import 'dotenv/config';
import admin from 'firebase-admin';

// Initialize Firebase
const app = admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
});
const firestore = admin.firestore();

async function checkData() {
    try {
        console.log('🔍 Checking Firestore data...');

        // Check guilds
        const guildsSnapshot = await firestore.collection('guilds').get();
        console.log(`📊 Found ${guildsSnapshot.docs.length} guilds`);

        if (guildsSnapshot.docs.length === 0) {
            console.log('✅ No data to migrate - you can start fresh!');
            process.exit(0);
        }

        let totalProfiles = 0;
        let totalTags = 0;
        let totalUsers = 0;

        for (const guildDoc of guildsSnapshot.docs) {
            const guildId = guildDoc.id;
            console.log(`\n🏰 Guild: ${guildId}`);

            // Check profiles
            const profilesSnapshot = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('profiles')
                .get();
            console.log(`  👤 Profiles: ${profilesSnapshot.docs.length}`);
            totalProfiles += profilesSnapshot.docs.length;

            // Check tags
            const tagsSnapshot = await firestore
                .collection('guilds')
                .doc(guildId)
                .collection('tags')
                .get();
            console.log(`  🏷️ Tags: ${tagsSnapshot.docs.length}`);
            totalTags += tagsSnapshot.docs.length;

            // Check tag members
            for (const tagDoc of tagsSnapshot.docs) {
                const membersSnapshot = await firestore
                    .collection('guilds')
                    .doc(guildId)
                    .collection('tags')
                    .doc(tagDoc.id)
                    .collection('members')
                    .get();
                totalUsers += membersSnapshot.docs.length;
            }
        }

        console.log(`\n📈 Summary:`);
        console.log(`  🏰 Guilds: ${guildsSnapshot.docs.length}`);
        console.log(`  👤 Profiles: ${totalProfiles}`);
        console.log(`  🏷️ Tags: ${totalTags}`);
        console.log(`  👥 Tag memberships: ${totalUsers}`);

        if (totalProfiles > 0 || totalTags > 0) {
            console.log(`\n💡 You have data to migrate! Run: node src/migrate_firestore_to_sqlite.js`);
        } else {
            console.log(`\n✅ No important data found - you can start fresh!`);
        }

    } catch (error) {
        console.error('❌ Error checking data:', error);
    } finally {
        process.exit(0);
    }
}

checkData();