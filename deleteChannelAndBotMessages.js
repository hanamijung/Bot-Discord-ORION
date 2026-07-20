require('dotenv').config();
const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');

const GUILD_ID = '1472695550028546349';
const CHANNEL_ID_TO_DELETE = '1508208833397522522';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ลบข้อความของบอทเองทั้งหมดในห้องเดียว (ไล่ทีละ 100 ข้อความ ย้อนไปเรื่อยๆ)
async function deleteBotMessagesInChannel(channel) {
    let deleted = 0;
    let lastId;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        let messages;
        try {
            messages = await channel.messages.fetch(options);
        } catch (error) {
            console.error(`❌ ดึงข้อความห้อง #${channel.name} ไม่ได้:`, error.message);
            break;
        }

        if (messages.size === 0) break;
        lastId = messages.last().id;

        const ownMessages = messages.filter((m) => m.author.id === client.user.id);
        for (const msg of ownMessages.values()) {
            try {
                await msg.delete();
                deleted++;
                await sleep(400); // กัน rate limit
            } catch (error) {
                console.error(`⚠️ ลบข้อความไม่ได้ (${msg.id}):`, error.message);
            }
        }

        if (messages.size < 100) break;
    }

    return deleted;
}

client.once(Events.ClientReady, async () => {
    console.log(`🤖 บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.error(`ไม่พบ Guild ID: ${GUILD_ID}`);
        process.exit(1);
    }

    // 1) ลบห้องที่กำหนด
    const channelToDelete = guild.channels.cache.get(CHANNEL_ID_TO_DELETE);
    if (channelToDelete) {
        try {
            await channelToDelete.delete('ลบตามคำสั่งแอดมิน');
            console.log(`✅ ลบห้อง #${channelToDelete.name} เรียบร้อยแล้ว`);
        } catch (error) {
            console.error(`❌ ลบห้อง ${CHANNEL_ID_TO_DELETE} ไม่ได้:`, error.message);
        }
    } else {
        console.error(`ไม่พบ Channel ID: ${CHANNEL_ID_TO_DELETE} (อาจถูกลบไปแล้ว)`);
    }

    // 2) ลบข้อความของบอทเองทุกห้องในเซิร์ฟเวอร์
    const textChannels = guild.channels.cache.filter(
        (ch) =>
            ch.id !== CHANNEL_ID_TO_DELETE &&
            (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    );

    console.log(`🔄 กำลังลบข้อความของบอทใน ${textChannels.size} ห้อง...`);

    let totalDeleted = 0;
    for (const channel of textChannels.values()) {
        const count = await deleteBotMessagesInChannel(channel);
        if (count > 0) console.log(`   #${channel.name}: ลบไป ${count} ข้อความ`);
        totalDeleted += count;
    }

    console.log(`✅ เสร็จสิ้น — ลบข้อความของบอทไปทั้งหมด ${totalDeleted} ข้อความ`);
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
