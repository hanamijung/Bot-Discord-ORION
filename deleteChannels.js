require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const GUILD_ID = '1472695550028546349';
const CHANNEL_IDS_TO_DELETE = [
    '1513821555929382923',
    '1513821672371781703',
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// สคริปต์รันครั้งเดียว: ลบห้องตาม CHANNEL_IDS_TO_DELETE แล้วปิดตัวเอง
client.once(Events.ClientReady, async () => {
    console.log(`🤖 บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.error(`ไม่พบ Guild ID: ${GUILD_ID}`);
        process.exit(1);
    }

    for (const channelId of CHANNEL_IDS_TO_DELETE) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            console.error(`ไม่พบ Channel ID: ${channelId} (อาจถูกลบไปแล้ว)`);
            continue;
        }
        try {
            const name = channel.name;
            await channel.delete('ลบตามคำสั่งแอดมิน');
            console.log(`✅ ลบห้อง #${name} (${channelId}) เรียบร้อยแล้ว`);
        } catch (error) {
            console.error(`❌ ลบห้อง ${channelId} ไม่ได้:`, error.message);
        }
    }

    console.log('✅ เสร็จสิ้น');
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
