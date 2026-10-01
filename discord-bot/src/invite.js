'use strict';
// Prints the link that adds the bot to your server.
const { loadEnv, requireEnv } = require('./util');

loadEnv();
requireEnv('DISCORD_CLIENT_ID');
// permissions=8 is Administrator: setup creates roles, channels, permissions and AutoMod rules, which needs it.
const url = `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;
console.log('Open this link, pick the Tree Host server, and approve:\n');
console.log(url);
