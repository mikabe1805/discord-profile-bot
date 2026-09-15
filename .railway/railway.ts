import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const discordProfileBotVolume = volume("discord-profile-bot-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-east4-eqdc4a",
    sizeMB: 500,
  });

  const discordProfileBot = service("discord-profile-bot", {
    source: github("mikabe1805/discord-profile-bot", {
      branch: "main",
      checkSuites: true,
    }),
    build: {
      builder: "DOCKERFILE",
      buildEnvironment: "V3",
      dockerfilePath: "Dockerfile",
    },
    start: "npm run start:production",
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: {
      // Railway stores its effective restart defaults as null; declaring them
      // makes every later config plan repeat the same update after a successful apply.
      ipv6EgressEnabled: false,
      runtime: "V2",
      sleepApplication: true,
      useLegacyStacker: false,
    },
    volumeMounts: { "/data": discordProfileBotVolume },
    env: {
      CLIENT_ID: preserve(),
      DATA_DIR: preserve(),
      DISCORD_TOKEN: preserve(),
      FIREBASE_CLIENT_EMAIL: preserve(),
      FIREBASE_PRIVATE_KEY: preserve(),
      FIREBASE_PROJECT_ID: preserve(),
      GUILD_ID: preserve(),
      IMGBB_API_KEY: preserve(),
    },
  });

  return project("discord-profile-bot", {
    resources: [discordProfileBot, discordProfileBotVolume],
  });
});
