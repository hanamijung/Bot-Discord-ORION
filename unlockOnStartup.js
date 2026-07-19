require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const TARGET_GUILD_ID = '1472695550028546349';

// ห้องที่ไม่ต้องปลดล็อค (คงสิทธิ์เดิมไว้)
const EXCLUDED_CHANNEL_IDS = [
    '1472702561533431912',
    '1507262393682759722',
    '1472698337772961843',
    '1472698679998681352',
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// ตอนบอทออนไลน์ → ปลดล็อคทุกห้องให้ @everyone มองเห็นได้ เฉพาะ Guild ที่กำหนด (ยกเว้นห้องใน EXCLUDED_CHANNEL_IDS)
client.once(Events.ClientReady, async () => {
    console.log(`🤖 บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);

    const guild = client.guilds.cache.get(TARGET_GUILD_ID);
    if (!guild) {
        console.error(`ไม่พบ Guild ID: ${TARGET_GUILD_ID}`);
        return;
    }

    console.log(`🔄 [Startup] กำลังปลดล็อคทุกห้องใน ${guild.name}...`);

    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(
        (ch) =>
            typeof ch.permissionOverwrites?.edit === 'function' &&
            !EXCLUDED_CHANNEL_IDS.includes(ch.id)
    );

    let success = 0;
    let failed = 0;
    const failedChannels = [];

    // sequential กัน rate limit ของ Discord API
    for (const channel of channels.values()) {
        try {
            await channel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: true,
            });
            success++;
        } catch (error) {
            failed++;
            failedChannels.push(channel.name);
            console.error(`ไม่สามารถแก้ไขสิทธิ์ห้อง ${channel.name} ได้:`, error);
        }
    }

    console.log(`✅ [Startup] ปลดล็อคสำเร็จ ${success} ห้อง (ข้าม ${EXCLUDED_CHANNEL_IDS.length} ห้องที่ตั้งไว้)`);
    if (failed > 0) {
        console.log(`⚠️ [Startup] ล้มเหลว ${failed} ห้อง: ${failedChannels.join(', ')}`);
    }
});

client.login(process.env.BOT_TOKEN);
