const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType,
    MessageFlags,
    SlashCommandBuilder,
    REST,
    Routes,
} = require('discord.js');
const mongoose = require('mongoose');
const express  = require('express');

// ════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGOTOKEN;
const MEMBER_ROLE_ID         = '1472776595554042049';

const ALLOWED_ROLE_IDS = [
    '1472701329146380481', // Head
    '1472700955903393794', // Boss
    '1472700601744756789', // Ownet
    '1506957405014065204',
];
const COOLDOWN_MS = 3000;

// ════════════════════════════════════════════════════════
//  EXPRESS KEEPALIVE
// ════════════════════════════════════════════════════════
const app = express();
app.get('/', (_, res) => res.send('บอทยังอยู่นะ!'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server พร้อมแล้ว'));

// ════════════════════════════════════════════════════════
//  PROTECTED CHANNELS (channel ที่บอทส่ง !setup ไว้)
// ════════════════════════════════════════════════════════
const protectedChannels = new Set();

// ════════════════════════════════════════════════════════
//  DISCORD CLIENT
// ════════════════════════════════════════════════════════
const client = new Client( {
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ════════════════════════════════════════════════════════
//  COOLDOWN
// ════════════════════════════════════════════════════════
const cooldownMap = new Map();

function checkCooldown(userId, eventId) {
    const key = `${userId}:${eventId}`;
    const last = cooldownMap.get(key) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return true;
    cooldownMap.set(key, Date.now());
    return false;
}

// ════════════════════════════════════════════════════════
//  MONGODB SCHEMAS
// ════════════════════════════════════════════════════════
const Event = mongoose.model('Event', new mongoose.Schema({
    eventId: {
        type: String, unique: true
    },
    channelId: String,
    title: String,
    desc: String,
    imageUrl: { type: String, default: '' },
    participants: [String],
    waitingList: [Object],
    attendedUserTags: [String],
    maxSlots: {
        type: Number, default: 0
        },
        endTime: Date,
        endTimeStr: String,
        active: {
            type: Boolean, default: true
        },
    }));

    const History = mongoose.model('History', new mongoose.Schema({
        userId: {
            type: String, unique: true
        },
        userTag: String,
        records: [{
            eventId: String,
            eventTitle: String,
            attendedAt: {
                type: Date, default: Date.now
            },
        }],
    }));

    // ─── Schema: Roblox-Discord Sync ─────────────────────────
    const RobloxSync = mongoose.model('RobloxSync', new mongoose.Schema({
        discordId:       { type: String, unique: true },
        robloxId:        String,
        robloxUsername:  String,
        lastDisplayName: String,
    }));

    // ════════════════════════════════════════════════════════
    //  HELPERS
    // ════════════════════════════════════════════════════════
    const E = (msg) => ({
        content: msg, flags: [MessageFlags.Ephemeral]
    });

    function hasPermission(member) {
        return member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id)) || member.permissions.has('Administrator');
    }

    function getUserTag(member, user) {
        return user.id; // เก็บ userId เพื่อ tag และ match ได้ถูกต้อง
    }

    // ดึง displayName จาก userId — ถ้าไม่เจอใช้ fallback
    async function resolveDisplayName(guildObj, userId) {
        if (!/^\d{17,20}$/.test(userId)) return userId; // ชื่อเดิม (ไม่ใช่ userId)
        try {
            const m = await guildObj.members.fetch(userId);
            return m.displayName;
        } catch {
            return `<@${userId}>`; // fallback ถ้า fetch ไม่ได้
        }
    }

    async function resolveList(guildObj, ids) {
        const results = [];
        for (const id of ids) {
            results.push(await resolveDisplayName(guildObj, id));
        }
        return results;
    }

    function stripMention(userTag) {
        return userTag.replace(/\s*\(.*?\)\s*/g, '').trim();
    }

    function extractUserId(userTag) {
        return userTag.match(/<@(\d+)>/)?.[1] ?? null;
    }

    async function buildEventEmbed(event, guildObj) {
        // resolve display names ถ้ามี guild
        let mainNames = event.participants;
        if (guildObj) {
            mainNames = await Promise.all(event.participants.map(id => resolveDisplayName(guildObj, id)));
        }
        const mainList = mainNames.length
        ? mainNames.map((p, i) => `${i + 1}. ${p}`).join('\n') : '_ยังว่างอยู่เลย รีบลงชื่อด่วน!_';

        let waitNames = event.waitingList.map(p => ({ ...p, display: p.userTag }));
        if (guildObj) {
            waitNames = await Promise.all(event.waitingList.map(async p => ({
                ...p, display: await resolveDisplayName(guildObj, p.userTag)
            })));
        }
        const waitList = waitNames.length
        ? waitNames.map((p, i) =>
            `${i + 1}. ${p.display} ${p.wantMain ? '' : ''}`)
        .join('\n') : '_ไม่มีใครรอสำรองอยู่_';

        const slotText = event.maxSlots > 0
        ? `${event.participants.length} / ${event.maxSlots} คน`: 'ไม่จำกัด';

        return new EmbedBuilder()
        .setTitle(`📌 ${event.title}`)
        .setDescription([
            event.desc,
            '',
            `🕒 **ปิดรับ:** ${event.endTimeStr}`,
            `👥 **โควต้า:** \`${slotText}\``,
            '',
            `**🟢 ตัวจริง:**\n${mainList}`,
            '',
            `**⏳ รายชื่อสำรอง:**\n${waitList}`,
        ].join('\n'))
        .setColor(event.active ? 0x5865F2: 0x99AAB5)
        .setImage(event.imageUrl || null)
        .setFooter({
            text: `ID: ${event.eventId}  •  ${event.active ? '🟢 เปิดรับอยู่': '🔴 ปิดรับแล้ว'}`
        });
    }

    function buildJoinButtons(eventId) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`join_${eventId}`).setLabel('🙋 ลงชื่อตัวจริง').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`wait_${eventId}`).setLabel('⏳ ลงชื่อสำรอง').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`leave_${eventId}`).setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Danger),
        );
    }

    async function recordHistory(userId, userTag, eventId, eventTitle) {
        await History.findOneAndUpdate(
            {
                userId
            },
            {
                $set: {
                    userTag
                }, $push: {
                    records: {
                        eventId, eventTitle
                    }
                }
            },
            {
                upsert: true
            },
        );
    }

    // ── Helper: สร้าง checkin page ────────────────────────────────────────────
    async function buildCheckinPage(interaction, event, page = 0) {
        const PAGE_SIZE = 24;
        const allPeople = [
            ...event.participants.map(t => ({ userTag: t, type: 'main' })),
            ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
        ];
        const attended  = event.attendedUserTags ?? [];
        const typeLabel = { main: '🟢 ตัวจริง', wait_main: '⏳ รอคิว', wait_reserve: '💤 สำรอง' };
        const totalPages = Math.ceil(allPeople.length / PAGE_SIZE);
        const pagePeople = allPeople.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        const options = pagePeople.map(({ userTag, type }) => ({
            label:       (attended.includes(userTag) ? '✅ ' : '') + stripMention(userTag).substring(0, 20),
            description: `${typeLabel[type]}  •  ${attended.includes(userTag) ? 'เช็คแล้ว' : 'ยังไม่ได้เช็ค'}`,
            value:       `${event.eventId}||${userTag}`.substring(0, 100),
    }));

        const checkedOptions = pagePeople
            .filter(({ userTag }) => attended.includes(userTag))
            .map(({ userTag, type }) => ({
                label:       '✅ ' + stripMention(userTag).substring(0, 20),
                description: `${typeLabel[type]}  •  เช็คแล้ว`,
                value:       `${event.eventId}||${userTag}`.substring(0, 100),
            }));

        const components = [];

        // Dropdown เพิ่ม
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_checkin_add')
                .setPlaceholder(`☑️ ติ๊กคนที่มาจริง (หน้า ${page + 1}/${totalPages})...`)
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options),
        ));

        // Dropdown ยกเลิก (เฉพาะคนที่เช็คแล้วในหน้านี้)
        if (checkedOptions.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_checkin_remove')
                    .setPlaceholder(`❌ ติ๊กออกคนที่เช็คผิด (หน้า ${page + 1}/${totalPages})...`)
                    .setMinValues(1)
                    .setMaxValues(checkedOptions.length)
                    .addOptions(checkedOptions),
            ));
    }

        // ปุ่มเปลี่ยนหน้า
        if (totalPages > 1) {
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`checkin_page||${event.eventId}||${page - 1}`)
                    .setLabel('◀ ก่อนหน้า')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`checkin_page||${event.eventId}||${page + 1}`)
                    .setLabel('▶ ถัดไป')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === totalPages - 1),
            );
            components.push(navRow);
    }

        return {
            content:    `☑️ **เช็คชื่อ: ${event.title}** — หน้า ${page + 1}/${totalPages}\nเช็คไปแล้ว ${attended.length} / ${allPeople.length} คน`,
            components,
            flags:      [MessageFlags.Ephemeral],
    };
    }


    // ════════════════════════════════════════════════════════
    //  READY
    // ════════════════════════════════════════════════════════
    client.once('clientReady', async () => {
        console.log(`🤖 บอทออนไลน์แล้ว: ${client.user.tag}`);
        try {
            if (!MONGO_URI) throw new Error('ไม่เจอตัวแปร MONGOTOKEN');
            await mongoose.connect(MONGO_URI);
            console.log('🍃 ต่อ MongoDB สำเร็จ!');
        } catch (err) {
            console.error('❌ ต่อ MongoDB ไม่ได้:', err.message);
        }

        // Roblox Sync — เช็ค Display Name ทุก 5 นาที
        setInterval(async () => {
            try {
                const syncs = await RobloxSync.find({});
                for (const sync of syncs) {
                    try {
                        const res  = await fetch(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                        const data = await res.json();
                        if (!data || !data.displayName) continue;
                        if (data.displayName === sync.lastDisplayName) continue;
                        if (!data.displayName.toUpperCase().startsWith('ORION')) continue;

                        const guild  = client.guilds.cache.first();
                        if (!guild) continue;
                        const member = await guild.members.fetch(sync.discordId).catch(() => null);
                        if (!member) continue;

                        const currentName   = member.displayName;
                        const bracketMatch  = currentName.match(/[(](.+)[)]$/);
                        const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
                        const finalName     = `${data.displayName} (${bracketSuffix})`;

                        await member.setNickname(finalName).catch(() => {});
                        sync.lastDisplayName = data.displayName;
                        await sync.save();
                        console.log(`🔄 เปลี่ยนชื่อ ${sync.discordId} → ${finalName}`);
                    } catch { /* ข้ามถ้า fetch ล้มเหลว */ }

                    // delay 500ms ต่อคน กันโดน rate limit
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch { /* ข้ามถ้า DB ล้มเหลว */ }
        }, 5 * 60_000);

        // ปิดกิจกรรมที่หมดเวลาอัตโนมัติทุก 1 นาที
        setInterval(async () => {
            const expired = await Event.find({
                active: true, endTime: {
                    $lte: new Date()
                }
            });
            for (const ev of expired) {
                ev.active = false;
                await ev.save();
                console.log(`⏰ ปิดกิจกรรมอัตโนมัติ: ${ev.title}`);
            }
        },
            60_000);
    });

    // ── Register Slash Commands (อยู่ใน clientReady) ───────
    const commands = [
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('สร้างแผงจัดการกิจกรรมใน channel นี้'),
        new SlashCommandBuilder()
            .setName('lock')
            .setDescription('ล็อค channel ไม่ให้สมาชิกพิมพ์'),
        new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('ปลดล็อค channel ให้สมาชิกพิมพ์ได้'),
        new SlashCommandBuilder()
            .setName('register')
            .setDescription('ลงทะเบียน Roblox ID')
            .addStringOption(o => o.setName('robloxid').setDescription('Roblox Username ของผู้เล่น').setRequired(true))
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่จะ register (ไม่ใส่ = ตัวเอง)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('unregister')
            .setDescription('ยกเลิก Roblox Sync')
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่จะยกเลิก (ไม่ใส่ = ตัวเอง)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('setup-register')
            .setDescription('สร้างแผงลงทะเบียนสมาชิกใน channel นี้'),
        new SlashCommandBuilder()
            .setName('staff-remove')
            .setDescription('ลบสมาชิกออกจากตำแหน่ง')
            .addStringOption(o => o.setName('position').setDescription('ชื่อตำแหน่ง').setRequired(true))
            .addStringOption(o => o.setName('member_name').setDescription('ชื่อสมาชิกที่จะลบ').setRequired(true)),
        new SlashCommandBuilder()
            .setName('robloxlist')
            .setDescription('ดึงรายชื่อ Roblox ของสมาชิกทุกคนที่ลงทะเบียนแล้ว'),
        new SlashCommandBuilder()
            .setName('robloxinfo')
            .setDescription('ดูข้อมูล Roblox ของสมาชิกคนที่ระบุ')
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่ต้องการดู').setRequired(true)),
    ].map(c => c.toJSON());

    client.once('clientReady', async () => {
        const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
        try {
            const guilds = client.guilds.cache.map(g => g.id);
            for (const guildId of guilds) {
                await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
            }
            console.log('✅ Register Slash Commands สำเร็จ!');
        } catch (err) {
            console.error('❌ Register Slash Commands ไม่ได้:', err.message);
        }
    });

    // ── messageCreate (ลบข้อความใน channel ที่ล็อค) ──
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;

        // ลบข้อความที่ไม่ใช่บอทใน channel ที่ป้องกันไว้
        if (protectedChannels.has(message.channel.id)) {
            if (!hasPermission(message.member)) {
                await message.delete().catch(() => {});
                return;
            }
        }
    });

    // ════════════════════════════════════════════════════════
    //  SLASH COMMANDS
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName, member, channel, guild } = interaction;

        // /setup
        if (commandName === 'setup') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            const embed = new EmbedBuilder()
                .setTitle('📅 ระบบจัดการกิจกรรม')
                .setDescription('อยากจัดการหรืออยากลงชื่อเข้าร่วมก็กดได้เลย 👇')
                .setFooter({ text: `📅 อัปเดตล่าสุด: ${new Date().toLocaleDateString('th-TH')}` })
                .setColor(0x5865F2);

            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('main_list_btn').setLabel('📅 ดูกิจกรรม / ลงชื่อ').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('main_history_btn').setLabel('📖 ประวัติของฉัน').setStyle(ButtonStyle.Secondary),
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('main_manage_btn').setLabel('⚙️ จัดการกิจกรรม').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('main_export_btn').setLabel('📋 ดึงรายชื่อ').setStyle(ButtonStyle.Secondary),
            );

            await channel.send({ embeds: [embed], components: [row1, row2] });
            protectedChannels.add(channel.id);
            return interaction.reply({ content: '✅ สร้างแผงกิจกรรมแล้ว!', flags: [MessageFlags.Ephemeral] });
        }

        // /lock
        if (commandName === 'lock') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
            protectedChannels.add(channel.id);
            return interaction.reply({ content: '🔒 ล็อค channel นี้แล้ว! ข้อความจากสมาชิกจะถูกลบอัตโนมัติ', flags: [MessageFlags.Ephemeral] });
        }

        // /unlock
        if (commandName === 'unlock') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
            protectedChannels.delete(channel.id);
            return interaction.reply({ content: '🔓 ปลดล็อค channel นี้แล้ว! สมาชิกพิมพ์ได้ตามปกติ', flags: [MessageFlags.Ephemeral] });
        }

        // /register
        if (commandName === 'register') {
            const targetUser   = interaction.options.getUser('user');
            const robloxUsername = interaction.options.getString('robloxid');
            let   targetMember = targetUser
                ? await guild.members.fetch(targetUser.id).catch(() => null)
                : member;

            if (targetUser && !hasPermission(member))
                return interaction.reply({ content: '❌ ต้องเป็นแอดมินหรือสตาฟถึงจะ register ให้คนอื่นได้นะ', flags: [MessageFlags.Ephemeral] });
            if (!targetMember)
                return interaction.reply({ content: '❌ หาสมาชิกคนนั้นไม่เจอเลย', flags: [MessageFlags.Ephemeral] });
            if (!robloxUsername)
                return interaction.reply({ content: '❌ กรุณาใส่ Roblox Username นะ', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            // หา userId จาก Username ก่อน แล้วค่อยดึง displayName
            let robloxId, displayName;
            try {
                const res  = await fetch('https://users.roblox.com/v1/usernames/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
                });
                const data = await res.json();
                if (!data?.data?.length) return interaction.editReply(`❌ ไม่เจอ Username **${robloxUsername}** ใน Roblox เลย ลองเช็คใหม่นะ`);
                robloxId    = String(data.data[0].id);
                displayName = data.data[0].displayName;
                if (!displayName.toUpperCase().startsWith('ORION'))
                    return interaction.editReply(`❌ Display Name **${displayName}** ไม่ขึ้นต้นด้วย ORION นะ ลองเปลี่ยนชื่อในเกมก่อนแล้วค่อย register ใหม่`);
            } catch {
                return interaction.editReply('❌ เรียก Roblox API ไม่ได้ตอนนี้ ลองใหม่อีกทีนะ');
            }

            // เช็คซ้ำ — Discord คนนี้ลงทะเบียนแล้วหรือยัง
            const existingByDiscord = await RobloxSync.findOne({ discordId: targetMember.id });
            // เช็คซ้ำ — Roblox ID นี้มีคนอื่น register ไปแล้วหรือยัง
            const existingByRoblox  = await RobloxSync.findOne({ robloxId, discordId: { $ne: targetMember.id } });

            if (existingByDiscord) {
                const isSelf = targetMember.id === interaction.user.id;
                return interaction.editReply(
                    `⚠️ ${isSelf ? 'คุณ' : `**${targetMember.displayName}**`} ลงทะเบียนไปแล้วนะ (Roblox: \`${existingByDiscord.robloxUsername || existingByDiscord.lastDisplayName}\`)\n` +
                    `ถ้าอยากอัปเดตข้อมูลใหม่ ให้ใช้ \`/unregister\` ก่อนแล้วค่อย register ใหม่`
                );
            }
            if (existingByRoblox) {
                const otherMember = await interaction.guild.members.fetch(existingByRoblox.discordId).catch(() => null);
                return interaction.editReply(
                    `⚠️ Roblox Username **${robloxUsername}** ถูก register โดย ${otherMember ? `<@${otherMember.id}>` : 'สมาชิกคนอื่น'} ไปแล้วนะ`
                );
            }

            await RobloxSync.findOneAndUpdate(
                { discordId: targetMember.id },
                { discordId: targetMember.id, robloxId, robloxUsername, lastDisplayName: displayName },
                { upsert: true }
            );

            const currentName   = targetMember.displayName;
            const bracketMatch  = currentName.match(/\((.+)\)$/);
            const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
            const finalName     = `${displayName} (${bracketSuffix})`;
            await targetMember.setNickname(finalName).catch(() => {});


            return interaction.editReply(`✅ ลงทะเบียน **${targetMember.displayName}** กับ Username **${robloxUsername}** เรียบร้อย! เปลี่ยนชื่อเป็น **${finalName}** แล้ว บอทจะเช็คชื่อทุก 5 นาทีนะ`);
        }

        // /robloxlist — ดึงรายชื่อทุกคน
        if (commandName === 'robloxlist') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const syncs = await RobloxSync.find({});
            if (!syncs.length)
                return interaction.editReply('😅 ยังไม่มีสมาชิกลงทะเบียนเลย');

            // ดึง displayName ล่าสุดจาก Discord
            const lines = [];
            for (const sync of syncs) {
                const m = await interaction.guild.members.fetch(sync.discordId).catch(() => null);
                const discordName = m ? m.displayName : `<@${sync.discordId}>`;
                lines.push(`**${discordName}**
🎮 Roblox Username: \`${sync.robloxUsername || sync.lastDisplayName}\``);
            }

            // แบ่งหน้าถ้าเกิน 10 คน
            const PAGE = 10;
            const pages = [];
            for (let i = 0; i < lines.length; i += PAGE)
                pages.push(lines.slice(i, i + PAGE).join("\n\n"));

            const embed = new EmbedBuilder()
                .setTitle(`📋 รายชื่อ Roblox ทั้งหมด (${syncs.length} คน)`)
                .setDescription(pages[0])
                .setColor(0x5865F2)
                .setFooter({ text: `หน้า 1/${pages.length}  •  ทั้งหมด ${syncs.length} คน` });

            const components = [];
            if (pages.length > 1) {
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('robloxlist_page||0||-1').setLabel('◀ ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    new ButtonBuilder().setCustomId(`robloxlist_page||${JSON.stringify(pages)}||1`).setLabel('▶ ถัดไป').setStyle(ButtonStyle.Secondary).setDisabled(pages.length <= 1),
                ));
            }
            return interaction.editReply({ embeds: [embed], components });
        }

        // /robloxinfo — ดูข้อมูลคนที่ระบุ
        if (commandName === 'robloxinfo') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            const targetUser = interaction.options.getUser('user');
            const sync = await RobloxSync.findOne({ discordId: targetUser.id });

            if (!sync)
                return interaction.reply({ content: `😕 **${targetUser.username}** ยังไม่ได้ลงทะเบียนเลย`, flags: [MessageFlags.Ephemeral] });

            // ดึงข้อมูลล่าสุดจาก Roblox API
            let currentDisplayName = sync.lastDisplayName;
            let profileUrl = `https://www.roblox.com/users/${sync.robloxId}/profile`;
            try {
                const res  = await fetch(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                const data = await res.json();
                if (data?.displayName) currentDisplayName = data.displayName;
            } catch { /* ใช้ค่าเดิมถ้า fetch ไม่ได้ */ }

            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

            const embed = new EmbedBuilder()
                .setTitle(`🎮 ข้อมูล Roblox ของ ${targetMember?.displayName ?? targetUser.username}`)
                .setDescription(
                    `👤 **Discord:** <@${targetUser.id}>
` +
                    `🎮 **Roblox ID:** \`${sync.robloxId}\`
` +
                    `✨ **Display Name ปัจจุบัน:** ${currentDisplayName}
` +
                    `🔗 **Profile:** [คลิกดูโปรไฟล์](${profileUrl})`
                )
                .setColor(0xFEE75C)
                .setFooter({ text: `ลงทะเบียนแล้ว • sync ทุก 5 นาที` });

            return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }

        // /setup-register
        if (commandName === 'setup-register') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            const embed = new EmbedBuilder()
                .setTitle('📋 ลงทะเบียนสมาชิก ORION')
                .setDescription(
                    'กดปุ่มด้านล่างเพื่อลงทะเบียนเข้าร่วมคลับ\n\n' +
                    '**สิ่งที่ต้องเตรียม:**\n' +
                    '🎮 Roblox Username ของคุณ\n' +
                    '🏷️ ชื่อเล่นที่อยากใช้\n\n' +
                    '⚠️ Display Name ใน Roblox ต้องขึ้นต้นด้วย **ORION** นะ'
                )
.setImage('https://img1.pic.in.th/images/1000040601.jpg')
                .setColor(0x5865F2)
                .setFooter({ text: `📅 อัปเดตล่าสุด: ${new Date().toLocaleDateString('th-TH')}` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('register_btn')
                    .setLabel('📝 ลงทะเบียน')
                    .setStyle(ButtonStyle.Success)
            );

            await channel.send({ embeds: [embed], components: [row] });
            return interaction.reply({ content: '✅ สร้างแผงลงทะเบียนเรียบร้อย!', flags: [MessageFlags.Ephemeral] });
        }

        // /unregister
        if (commandName === 'unregister') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
            const targetUser   = interaction.options.getUser('user');
            const targetId     = targetUser ? targetUser.id : member.id;
            await RobloxSync.findOneAndDelete({ discordId: targetId });
            // ถอด MEMBER role ด้วย
            const targetMember = await guild.members.fetch(targetId).catch(() => null);
            if (targetMember) {
                await targetMember.roles.remove(MEMBER_ROLE_ID).catch(() => {});
            }
            return interaction.reply({ content: `✅ ยกเลิก Roblox Sync และถอดยศ MEMBER ของ <@${targetId}> เรียบร้อย!`, flags: [MessageFlags.Ephemeral] });
        }
    });

    // ════════════════════════════════════════════════════════
    //  BUTTON: main_*
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('main_')) return;

        const {
            customId,
            member,
            user
        } = interaction;

        // ── ⚙️ จัดการกิจกรรม ──────────────────────────────
        if (customId === 'main_manage_btn') {
            if (!hasPermission(member))
                return interaction.reply(E('❌ แค่แอดมินหรือสตาฟเท่านั้นที่เข้าเมนูนี้ได้นะ'));

            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('action_add').setLabel('➕ เพิ่มกิจกรรม').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('action_edit').setLabel('✏️ แก้ไขกิจกรรม').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('action_delete').setLabel('🗑️ ลบกิจกรรม').setStyle(ButtonStyle.Danger),
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('action_toggle').setLabel('🔁 เปิด / ปิดกิจกรรม').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('action_checkin').setLabel('✅ เช็คชื่อผู้เข้าร่วม').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('action_manual_add').setLabel('📝 เพิ่มรายชื่อ Manual').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('action_remove_member').setLabel('🗑️ ลบรายชื่อสมาชิก').setStyle(ButtonStyle.Danger),
            );
            return interaction.reply({
                content: '⚙️ เลือกได้เลย:', components: [row1, row2], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📅 ดูกิจกรรม / ลงชื่อ ─────────────────────────
        if (customId === 'main_list_btn') {
            const events = await Event.find({
                active: true, channelId: interaction.channelId
            });
            if (!events.length)
                return interaction.reply(E('😅 ตอนนี้ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_view_event')
                .setPlaceholder('📌 เลือกกิจกรรมที่อยากเข้าร่วม...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: `โควต้า: ${ev.maxSlots > 0 ? `${ev.participants.length}/${ev.maxSlots}`: 'ไม่จำกัด'}`,
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '📅 กิจกรรมที่เปิดอยู่ตอนนี้:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📋 ดึงรายชื่อ ──────────────────────────────────
        if (customId === 'main_export_btn') {
            if (!hasPermission(member))
                return interaction.reply(E('❌ ไม่มีสิทธิ์ดึงรายชื่อนะ'));

            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length)
                return interaction.reply(E('😅 ยังไม่มีกิจกรรมในระบบเลย'));

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_export_event')
                .setPlaceholder('📋 เลือกกิจกรรมที่อยากดูรายชื่อ...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: `ตัวจริง: ${ev.participants.length}  •  สำรอง: ${ev.waitingList.length}`,
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '🔍 เลือกกิจกรรมที่ต้องการ:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📖 ประวัติของฉัน ───────────────────────────────
        if (customId === 'main_history_btn') {
            const history = await History.findOne({
                userId: user.id
            });
            if (!history?.records.length)
                return interaction.reply(E('📭 ยังไม่มีประวัติการเข้าร่วมเลยนะ ลองมาร่วมกิจกรรมดูสิ!'));

            const lines = history.records
            .slice(-20).reverse()
            .map((r, i) => `${i + 1}. **${r.eventTitle}** — ${new Date(r.attendedAt).toLocaleDateString('th-TH')}`);

            const embed = new EmbedBuilder()
            .setTitle(`📖 ประวัติของ ${member.displayName}`)
            .setDescription(lines.join('\n'))
            .setColor(0xFEE75C)
            .setFooter({
                text: `เข้าร่วมมาแล้วทั้งหมด ${history.records.length} ครั้ง`
            });

            return interaction.reply({
                embeds: [embed], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 🔢 เช็คคิวของฉัน ──────────────────────────────
        if (customId === 'main_myqueue_btn') {
            const userTag = getUserTag(member, user);
            const events = await Event.find({
                active: true,
                channelId: interaction.channelId,
                $or: [{
                    participants: userTag
                }, {
                    'waitingList.userTag': userTag
                }],
            });

            if (!events.length)
                return interaction.reply(E('📭 ตอนนี้ยังไม่ได้ลงชื่อกิจกรรมไหนอยู่เลย'));

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_myqueue_event')
                .setPlaceholder('🔢 เลือกกิจกรรมที่อยากดูคิว...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: ev.participants.includes(userTag) ? '✅ ตัวจริง': '⏳ อยู่ในคิวสำรอง',
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '🔢 กิจกรรมที่คุณลงชื่ออยู่ตอนนี้:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }
    });

    // ════════════════════════════════════════════════════════
    //  BUTTON: action_*  (เมนูจัดการของแอดมิน)
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('action_')) return;

        const {
            customId
        } = interaction;

        // ── ➕ เพิ่มกิจกรรม ────────────────────────────────
        if (customId === 'action_add') {
            const modal = new ModalBuilder().setCustomId('modal_create').setTitle('✨ สร้างกิจกรรมใหม่');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('title').setLabel('ชื่อกิจกรรม').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('desc').setLabel('รายละเอียด').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('time').setLabel('วันเวลาปิดรับ  (ปปปป-ดด-วว ชช:นน)').setPlaceholder('เช่น 2026-06-01 18:00').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('slots').setLabel('โควต้า (0 = ไม่จำกัด)').setPlaceholder('เช่น 20').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('image').setLabel('URL รูปภาพ (ไม่บังคับ)').setPlaceholder('เช่น https://i.imgur.com/abc.png').setStyle(TextInputStyle.Short).setRequired(false)),
            );
            return interaction.showModal(modal);
        }

        // ── ✏️ แก้ไขกิจกรรม ───────────────────────────────
        if (customId === 'action_edit') {
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_edit_event')
                .setPlaceholder('✏️ เลือกกิจกรรมที่อยากแก้ไข...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่': '🔴 ปิดแล้ว',
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '✏️ จะแก้ไขกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 🗑️ ลบกิจกรรม ──────────────────────────────────
        if (customId === 'action_delete') {
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ไม่มีกิจกรรมใน channel นี้เลย'));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_delete_event')
                .setPlaceholder('🗑️ เลือกกิจกรรมที่อยากลบออก...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่': '🔴 ปิดแล้ว',
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '⚠️ เลือกกิจกรรมที่จะ **ลบถาวร** ได้เลย:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 🔁 เปิด/ปิดกิจกรรม ────────────────────────────
        if (customId === 'action_toggle') {
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_toggle_event')
                .setPlaceholder('🔁 เลือกกิจกรรมที่จะสลับสถานะ...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่ → กดเพื่อปิด': '🔴 ปิดอยู่ → กดเพื่อเปิด',
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '🔁 สลับสถานะกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── ✅ เช็คชื่อผู้เข้าร่วม ─────────────────────────
        if (customId === 'action_manual_add') {
            if (!hasPermission(interaction.member))
                return interaction.reply(E('❌ ไม่มีสิทธิ์เพิ่มรายชื่อนะ'));
            const events = await Event.find({ active: true, channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_manual_add_event')
                    .setPlaceholder('📝 เลือกกิจกรรมที่จะเพิ่มรายชื่อ...')
                    .addOptions(events.map(ev => ({
                        label:       ev.title.substring(0, 25),
                        description: `ตัวจริง: ${ev.participants.length}${ev.maxSlots > 0 ? ` / ${ev.maxSlots}` : ''}`,
                        value:       ev.eventId,
                    }))),
            );
            return interaction.reply({ content: '📝 เลือกกิจกรรมที่จะเพิ่มรายชื่อ Manual:', components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (customId === 'action_remove_member') {
            if (!hasPermission(interaction.member))
                return interaction.reply(E('❌ ไม่มีสิทธิ์นะ'));
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
            const options = events.map(ev => ({
                label:       ev.title.substring(0, 25),
                description: `ตัวจริง: ${ev.participants.length} | สำรอง: ${ev.waitingList.length}`,
                value:       ev.eventId,
            }));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_remove_member_event')
                    .setPlaceholder('🗑️ เลือกกิจกรรมที่จะลบรายชื่อ...')
                    .addOptions(options)
            );
            return interaction.reply({ content: '🗑️ เลือกกิจกรรมที่จะลบรายชื่อสมาชิก:', components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (customId === 'action_checkin') {
            if (!hasPermission(interaction.member))
                return interaction.reply(E('❌ ไม่มีสิทธิ์เช็คชื่อนะ'));

            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return interaction.reply(E('😅 ยังไม่มีกิจกรรมในระบบเลย'));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                .setCustomId('select_checkin_event')
                .setPlaceholder('✅ เลือกกิจกรรมที่จะเช็คชื่อ...')
                .addOptions(events.map(ev => ({
                    label: ev.title.substring(0, 25),
                    description: `เช็คแล้ว ${(ev.attendedUserTags ?? []).length} / ${ev.participants.length + ev.waitingList.length} คน (ตัวจริง + สำรอง)`,
                    value: ev.eventId,
                }))),
            );
            return interaction.reply({
                content: '📋 เลือกกิจกรรมที่จะเช็คชื่อ:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }
    });

    // ════════════════════════════════════════════════════════
    //  MODAL SUBMIT
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (interaction.type !== InteractionType.ModalSubmit) return;

        // ── สร้างกิจกรรมใหม่ ──────────────────────────────
        // modal_register อยู่ใน handler เดียวกันนี้
        if (interaction.customId === 'modal_register') {
            const robloxUsername = interaction.fields.getTextInputValue('reg_roblox_username').trim();
            const nickname       = interaction.fields.getTextInputValue('reg_nickname').trim();

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            let robloxId, displayName;
            try {
                const res  = await fetch('https://users.roblox.com/v1/usernames/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true })
                });
                const data = await res.json();
                if (!data?.data?.length)
                    return interaction.editReply(`❌ ไม่เจอ Username **${robloxUsername}** ใน Roblox เลย ลองเช็คใหม่นะ`);
                robloxId    = String(data.data[0].id);
                displayName = data.data[0].displayName;
            } catch {
                return interaction.editReply('❌ เรียก Roblox API ไม่ได้ตอนนี้ ลองใหม่อีกทีนะ');
            }

            if (!displayName.toUpperCase().startsWith('ORION'))
                return interaction.editReply(`❌ Display Name **${displayName}** ไม่ขึ้นต้นด้วย **ORION** นะ กรุณาเปลี่ยนชื่อใน Roblox ก่อนแล้วค่อยลงทะเบียนใหม่`);

            // เช็คซ้ำ — Discord คนนี้ลงทะเบียนแล้วหรือยัง
            const existingByDiscord = await RobloxSync.findOne({ discordId: interaction.user.id });
            const existingByRoblox  = await RobloxSync.findOne({ robloxId, discordId: { $ne: interaction.user.id } });

            if (existingByDiscord)
                return interaction.editReply(
                    `⚠️ คุณลงทะเบียนไปแล้วนะ (Roblox: \`${existingByDiscord.robloxUsername || existingByDiscord.lastDisplayName}\`)\n` +
                    `ถ้าอยากเปลี่ยนข้อมูล ติดต่อแอดมินเพื่อ unregister ก่อนนะ`
                );
            if (existingByRoblox) {
                const otherMember = await interaction.guild.members.fetch(existingByRoblox.discordId).catch(() => null);
                return interaction.editReply(
                    `⚠️ Roblox Username **${robloxUsername}** ถูก register โดย ${otherMember ? `<@${otherMember.id}>` : 'สมาชิกคนอื่น'} ไปแล้วนะ`
                );
            }

            await RobloxSync.findOneAndUpdate(
                { discordId: interaction.user.id },
                { discordId: interaction.user.id, robloxId, robloxUsername, lastDisplayName: displayName },
                { upsert: true }
            );

            const finalName = `${displayName} (${nickname})`;
            await interaction.member.setNickname(finalName).catch(() => {});
            await interaction.member.roles.add(MEMBER_ROLE_ID).catch(() => {});


            return interaction.editReply(`✅ ลงทะเบียนเรียบร้อยแล้ว!\n🎮 Roblox: **${robloxUsername}**\n✨ ชื่อใหม่: **${finalName}**\n🏅 ได้รับยศ MEMBER แล้ว!\nบอทจะเช็คชื่อทุก 5 นาทีนะ`);
        }

        if (interaction.customId === 'modal_create') {
            const title = interaction.fields.getTextInputValue('title');
            const desc = interaction.fields.getTextInputValue('desc');
            const timeRaw = interaction.fields.getTextInputValue('time').trim();
            const slotsRaw = interaction.fields.getTextInputValue('slots').trim();

            const endTime = new Date(timeRaw);
            const maxSlots = parseInt(slotsRaw, 10);

            if (isNaN(endTime.getTime()))
                return interaction.reply(E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ ลองใหม่แบบนี้: `ปปปป-ดด-วว ชช:นน`'));
            if (isNaN(maxSlots) || maxSlots < 0)
                return interaction.reply(E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

            const imageUrl = interaction.fields.getTextInputValue('image').trim();
            const channelId = interaction.channelId;
            const eventId = `evt_${Date.now()}`;
            await new Event({
                eventId, channelId, title, desc, imageUrl,
                participants: [], waitingList: [], attendedUserTags: [],
                maxSlots, endTime, endTimeStr: timeRaw, active: true,
            }).save();

            return interaction.reply(E(`✅ สร้างกิจกรรม **"${title}"** เรียบร้อยแล้ว!\n📌 ID: \`${eventId}\``));
        }

        // ── เพิ่มรายชื่อ Manual ────────────────────────────
        if (interaction.customId.startsWith('modal_manual_add_')) {
            const eventId = interaction.customId.replace('modal_manual_add_', '');
            const event   = await Event.findOne({ eventId });
            if (!event) return interaction.reply(E('❌ หากิจกรรมนี้ไม่เจอแล้ว'));

            const rawInput = interaction.fields.getTextInputValue('manual_names');
            const userIds  = rawInput.split('\n').map(n => n.trim()).filter(n => /^\d{17,20}$/.test(n));
            const invalid  = rawInput.split('\n').map(n => n.trim()).filter(n => n.length > 0 && !/^\d{17,20}$/.test(n));

            if (!userIds.length)
                return interaction.reply(E('❌ ไม่เจอ User ID ที่ถูกต้องเลย ต้องเป็นตัวเลข 17-20 หลักนะ'));

            const added   = [];
            const skipped = [];
            const notFound = [];

            for (const uid of userIds) {
                // ดึง displayName จาก guild member
                let displayName;
                try {
                    const member = await interaction.guild.members.fetch(uid);
                    displayName  = member.displayName;
                } catch {
                    notFound.push(uid);
                    continue;
                }

                // เช็คซ้ำ
                const alreadyIn = event.participants.includes(displayName) || event.waitingList.some(p => p.userTag === displayName);
                if (alreadyIn) { skipped.push(displayName); continue; }

                if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
                    event.participants.push(displayName);
                    added.push(displayName);
                } else {
                    event.waitingList.push({ userTag: displayName, wantMain: true });
                    added.push(`${displayName} (คิวรอ)`);
                }
            }
            await event.save();

            const addedText    = added.length    ? added.map(n => `• ${n}`).join('\n')    : '_ไม่มี_';
            const skippedText  = skipped.length  ? skipped.map(n => `• ${n}`).join('\n')  : null;
            const notFoundText = notFound.length  ? notFound.map(n => `• ${n}`).join('\n') : null;
            const invalidText  = invalid.length   ? invalid.map(n => `• ${n}`).join('\n')  : null;

            return interaction.reply(E(
                `📝 เพิ่มรายชื่อ Manual เรียบร้อย!\n\n` +
                `✅ **เพิ่มแล้ว ${added.length} คน:**\n${addedText}\n` +
                (skippedText  ? `\n⚠️ **ซ้ำ ข้ามไป ${skipped.length} คน:**\n${skippedText}\n`          : '') +
                (notFoundText ? `\n❓ **หาไม่เจอในเซิร์ฟเวอร์ ${notFound.length} ID:**\n${notFoundText}\n` : '') +
                (invalidText  ? `\n❌ **รูปแบบไม่ถูกต้อง ${invalid.length} รายการ:**\n${invalidText}`      : '')
            ));
        }

        // ── แก้ไขกิจกรรม ──────────────────────────────────
        if (interaction.customId.startsWith('modal_edit_')) {
            const eventId = interaction.customId.replace('modal_edit_', '');
            const event = await Event.findOne({
                eventId
            });
            if (!event) return interaction.reply(E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปแล้ว'));

            const newTitle = interaction.fields.getTextInputValue('title').trim();
            const newDesc  = interaction.fields.getTextInputValue('desc').trim();
            const newTimeRaw = interaction.fields.getTextInputValue('time').trim();
            const newSlots = parseInt(interaction.fields.getTextInputValue('slots').trim(), 10);
            const newDate = new Date(newTimeRaw);

            if (isNaN(newDate.getTime()))
                return interaction.reply(E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ'));
            if (isNaN(newSlots) || newSlots < 0)
                return interaction.reply(E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

            if (newTitle) event.title = newTitle;
            if (newDesc)  event.desc  = newDesc;
            event.endTime = newDate;
            event.endTimeStr = newTimeRaw;
            event.maxSlots = newSlots;
            await event.save();

            return interaction.reply(E(`✅ อัปเดตกิจกรรม **"${event.title}"** เรียบร้อยแล้ว!`));
        }
    });

    // ════════════════════════════════════════════════════════
    //  SELECT MENU
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu()) return;

        const {
            customId,
            values,
            member,
            user
        } = interaction;
        const eventId = values[0];

        try {

        // ── ดูกิจกรรมเพื่อลงชื่อ ──────────────────────────
        if (customId === 'select_view_event') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const event = await Event.findOne({ eventId });
            if (!event) return interaction.editReply('😕 หากิจกรรมนี้ไม่เจอแล้ว');
            if (!event.active) return interaction.editReply('❌ กิจกรรมนี้ปิดรับแล้วนะ');

            return interaction.editReply({
                embeds: [await buildEventEmbed(event, interaction.guild)],
                components: [buildJoinButtons(eventId)],
            });
        }

        // ── เลือกกิจกรรมเพื่อลบรายชื่อ → Dropdown รายคน ──
    if (customId === 'select_remove_member_event') {
        const event = await Event.findOne({ eventId });
        if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const allPeople = [
            ...event.participants.map(t => ({ userTag: t, type: 'main' })),
            ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
        ];
        if (!allPeople.length) return interaction.reply(E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));

        const typeLabel = { main: '🟢 ตัวจริง', wait_main: '⏳ รอคิว', wait_reserve: '💤 สำรอง' };
        const memberNames = {};
        for (const { userTag } of allPeople) {
            memberNames[userTag] = await resolveDisplayName(interaction.guild, userTag);
        }

        const options = allPeople.slice(0, 25).map(({ userTag, type }) => ({
            label:       (memberNames[userTag] || userTag).substring(0, 25),
            description: typeLabel[type],
            value:       `${eventId}||${userTag}`.substring(0, 100),
        }));

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_remove_member_confirm')
                .setPlaceholder('🗑️ เลือกสมาชิกที่จะลบออก...')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options)
        );
        return interaction.reply({
            content: `🗑️ **ลบรายชื่อ: ${event.title}**
เลือกสมาชิกที่จะลบออกได้เลย (เลือกได้หลายคน)`,
            components: [row],
            flags: [MessageFlags.Ephemeral],
        });
    }

    // ── confirm ลบรายชื่อสมาชิก ──
    if (customId === 'select_remove_member_confirm') {
        const evId  = values[0].substring(0, values[0].indexOf('||'));
        const event = await Event.findOne({ eventId: evId });
        if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const removed = [];
        for (const val of values) {
            const userTag = val.substring(val.indexOf('||') + 2);
            // ลบจาก participants
            const pIdx = event.participants.indexOf(userTag);
            if (pIdx !== -1) {
                event.participants.splice(pIdx, 1);
                removed.push(userTag);
                // เลื่อนคนถัดไปในคิวขึ้นมา
                const nextIdx = event.waitingList.findIndex(p => p.wantMain);
                if (nextIdx !== -1) {
                    const promoted = event.waitingList.splice(nextIdx, 1)[0];
                    event.participants.push(promoted.userTag);
                }
            } else {
                // ลบจาก waitingList
                const wIdx = event.waitingList.findIndex(p => p.userTag === userTag);
                if (wIdx !== -1) { event.waitingList.splice(wIdx, 1); removed.push(userTag); }
            }
        }
        await event.save();

        const names = await Promise.all(removed.map(id => resolveDisplayName(interaction.guild, id)));
        return interaction.reply(E(
            `✅ ลบ **${removed.length} คน** ออกจากกิจกรรม **"${event.title}"** เรียบร้อย!
` +
            names.map(n => `• ${n}`).join('\n')
        ));
    }

    // ── เลือกกิจกรรมเพื่อเพิ่มรายชื่อ Manual → Modal ──
    if (customId === 'select_manual_add_event') {
        const event = await Event.findOne({ eventId });
        if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const modal = new ModalBuilder()
            .setCustomId(`modal_manual_add_${eventId}`)
            .setTitle(`📝 เพิ่มรายชื่อ: ${event.title.substring(0, 20)}`);
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('manual_names')
                    .setLabel('User ID (1 บรรทัด = 1 คน)')
                    .setPlaceholder(`123456789012345678\n987654321098765432`)
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
            ),
        );
        return interaction.showModal(modal);
    }

    // ── สรุปรายชื่อ ────────────────────────────────────
        if (customId === 'select_export_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            const mainList = event.participants.length
            ? event.participants.map((u, i) => `${i + 1}. ${u}`).join('\n'): '_ไม่มีรายชื่อ_';
            const waitList = event.waitingList.length
            ? event.waitingList.map((p, i) => `${i + 1}. ${p.userTag}  ${p.wantMain ? '': ''}`).join('\n'): '_ไม่มีรายชื่อสำรอง_';
            const attendedList = (event.attendedUserTags ?? []).length
            ? event.attendedUserTags.map((u, i) => `${i + 1}. ${u}`).join('\n'): '_ยังไม่มีการเช็คชื่อ_';

            const embed = new EmbedBuilder()
            .setTitle(`📊 สรุปรายชื่อ: ${event.title}`)
            .setDescription([
                `**🟢 ตัวจริง:**\n${mainList}`,
                `**⏳ สำรอง:**\n${waitList}`,
                `**✅ มาจริง (เช็คแล้ว):**\n${attendedList}`,
            ].join('\n\n'))
            .setColor(0xEB459E);

            return interaction.reply({
                embeds: [embed], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── เลือกกิจกรรมเพื่อแก้ไข → Modal ───────────────
        if (customId === 'select_edit_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            const modal = new ModalBuilder()
            .setCustomId(`modal_edit_${eventId}`)
            .setTitle(`✏️ แก้ไข: ${event.title.substring(0, 20)}`);
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('title').setLabel('ชื่อกิจกรรมใหม่').setStyle(TextInputStyle.Short).setRequired(false).setValue(event.title)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('desc').setLabel('รายละเอียดใหม่').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(event.desc || '')),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('time').setLabel('วันเวลาปิดรับใหม่ (ปปปป-ดด-วว ชช:นน)').setStyle(TextInputStyle.Short).setRequired(true).setValue(event.endTimeStr)),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('slots').setLabel('โควต้าใหม่ (0 = ไม่จำกัด)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(event.maxSlots))),
            );
            return interaction.showModal(modal);
        }

        // ── ลบกิจกรรม ──────────────────────────────────────
        if (customId === 'select_delete_event') {
            const deleted = await Event.findOneAndDelete({
                eventId
            });
            if (!deleted) return interaction.reply(E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปก่อนหน้านี้แล้ว'));
            return interaction.reply(E(`🗑️ ลบกิจกรรม **"${deleted.title}"** ออกจากระบบเรียบร้อย!`));
        }

        // ── สลับสถานะเปิด/ปิด ──────────────────────────────
        if (customId === 'select_toggle_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            event.active = !event.active;
            await event.save();
            return interaction.reply(E(
                event.active
                ? `🟢 เปิดรับลงชื่อแล้ว — **"${event.title}"**`: `🔴 ปิดรับลงชื่อแล้ว — **"${event.title}"**`
            ));
        }

        // ── เลือกกิจกรรมเพื่อเช็คชื่อ → Dropdown รายคน ───
        if (customId === 'select_checkin_event') {
            const event = await Event.findOne({ eventId });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            const allPeople = [
                ...event.participants.map(t => ({ userTag: t, type: 'main' })),
                ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
            ];
            if (!allPeople.length) return interaction.reply(E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));
            return interaction.reply(await buildCheckinPage(interaction, event, 0));
        }

        // ── เพิ่มเช็คชื่อ ───────────────────────────────────
        if (customId === 'select_checkin_add') {
            const evId = values[0].substring(0, values[0].indexOf('||'));
            const event = await Event.findOne({
                eventId: evId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            if (!event.attendedUserTags) event.attendedUserTags = [];

            const newlyChecked = [];
            for (const val of values) {
                const userTag = val.substring(val.indexOf('||') + 2);
                if (event.attendedUserTags.includes(userTag)) continue;
                event.attendedUserTags.push(userTag);
                newlyChecked.push(userTag);
                // userTag คือ userId ตรงๆ แล้ว บันทึกได้เลย
                await recordHistory(userTag, userTag, event.eventId, event.title);
            }
            await event.save();

            const total = event.participants.length + event.waitingList.length;
            const nameList = newlyChecked.length
            ? newlyChecked.map(t => `• ${stripMention(t)}`).join('\n'): '_ทุกคนที่เลือกเช็คแล้วทั้งหมด_';
            return interaction.reply(E(
                `✅ เช็คชื่อเพิ่มสำเร็จ! **${newlyChecked.length}** คน\n${nameList}\n\n` +
                `📊 รวมเช็คแล้ว ${event.attendedUserTags.length} / ${total} คน`
            ));
        }

        // ── ยกเลิกเช็คชื่อ (ติ๊กออก) ───────────────────────
        if (customId === 'select_checkin_remove') {
            const evId = values[0].substring(0, values[0].indexOf('||'));
            const event = await Event.findOne({
                eventId: evId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            const removed = [];
            for (const val of values) {
                const userTag = val.substring(val.indexOf('||') + 2);
                const idx = (event.attendedUserTags ?? []).indexOf(userTag);
                if (idx !== -1) {
                    event.attendedUserTags.splice(idx, 1);
                    removed.push(userTag);
                    // ลบออกจากประวัติด้วย
                    const uid = extractUserId(userTag);
                    if (uid) await History.findOneAndUpdate(
                        {
                            userId: uid
                        },
                        {
                            $pull: {
                                records: {
                                    eventId: event.eventId
                                }
                            }
                        }
                    );
                }
            }
            await event.save();

            const total = event.participants.length + event.waitingList.length;
            const nameList = removed.map(t => `• ${stripMention(t)}`).join('\n');
            return interaction.reply(E(
                `↩️ ยกเลิกเช็คชื่อ **${removed.length}** คนเรียบร้อย\n${nameList}\n\n` +
                `📊 รวมเช็คแล้ว ${event.attendedUserTags.length} / ${total} คน`
            ));
        }

        // ── ดูลำดับคิวของตัวเอง ────────────────────────────
        if (customId === 'select_myqueue_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            const userTag = getUserTag(member, user);

            const mainIdx = event.participants.indexOf(userTag);
            if (mainIdx !== -1)
                return interaction.reply(E(`✅ คุณอยู่ใน **ตัวจริง** ลำดับที่ **${mainIdx + 1}** — **"${event.title}"**`));

            const waitIdx = event.waitingList.findIndex(p => p.userTag === userTag);
            if (waitIdx !== -1) {
                const p = event.waitingList[waitIdx];
                const pos = event.waitingList.slice(0, waitIdx + 1).filter(w => w.wantMain === p.wantMain).length;
                const typeStr = p.wantMain ? '': '';
                return interaction.reply(E(`⏳ คุณอยู่ใน **${typeStr}** ลำดับที่ **${pos}** — **"${event.title}"**`));
            }

            return interaction.reply(E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
        }

        } catch (err) {
            console.error('❌ Select Menu Error:', err);
            try {
                const msg = '❌ เกิดข้อผิดพลาด ลองใหม่อีกทีนะ';
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: msg });
                } else {
                    await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
                }
            } catch { /* interaction หมดอายุไปแล้ว ข้ามได้ */ }
        }
    });

    // ════════════════════════════════════════════════════════
    //  BUTTON: join_ / wait_ / leave_
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (interaction.customId.startsWith('main_') || interaction.customId.startsWith('action_') || interaction.customId.startsWith('checkin_page||')) return;

        const {
            customId,
            member,
            user
        } = interaction;

        // ── ปุ่มลงทะเบียน ──────────────────────────────────
        if (interaction.customId === 'register_btn') {
            const modal = new ModalBuilder()
                .setCustomId('modal_register')
                .setTitle('📋 ลงทะเบียนสมาชิก ORION');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reg_roblox_username')
                        .setLabel('Roblox Username')
                        .setPlaceholder('เช่น ORIONxIT_Candybibi')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reg_nickname')
                        .setLabel('ชื่อเล่น')
                        .setPlaceholder('เช่น แคนดี้')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
            );
            return interaction.showModal(modal);
        }

        let action = 'leave';
        if (customId.startsWith('join_')) action = 'join';
        if (customId.startsWith('wait_')) action = 'wait';

        const eventId = customId.replace(`${action}_`, '');

        if (checkCooldown(user.id, eventId))
            return interaction.reply(E('⏱️ ใจเย็นๆ นะ รอแป๊บนึงแล้วลองใหม่!'));

        const event = await Event.findOne({
            eventId
        });
        if (!event) return interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        if (!event.active) return interaction.reply(E('❌ กิจกรรมนี้ปิดรับแล้วนะ'));

        const userTag = getUserTag(member, user);
        const isJoined = event.participants.includes(userTag) || event.waitingList.some(p => p.userTag === userTag);

        // ── ลงชื่อตัวจริง ──────────────────────────────────
        if (action === 'join') {
            if (isJoined) return interaction.reply(E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));

            if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
                event.participants.push(userTag);
                await event.save();
                await interaction.reply(E('✅ ลงชื่อ **ตัวจริง** เรียบร้อยแล้ว เจอกันนะ! 🎉'));
            } else {
                event.waitingList.push({
                    userTag, wantMain: true
                });
                await event.save();
                const pos = event.waitingList.filter(w => w.wantMain).length;
                await interaction.reply(E(`⏳ โควต้าเต็มแล้ว! คุณอยู่ในคิวสำรองลำดับที่ **${pos}** ถ้ามีคนถอนตัว เดี๋ยวแจ้ง DM ให้เลย 📩`));
            }
        }

        // ── ลงชื่อสำรอง ────────────────────────────────────
        else if (action === 'wait') {
            if (isJoined) return interaction.reply(E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));
            event.waitingList.push({
                userTag, wantMain: false
            });
            await event.save();
            await interaction.reply(E('💤 บันทึกเป็น **สำรอง** แล้วนะ ถ้าเปลี่ยนใจอยากขึ้นตัวจริงก็ยกเลิกแล้วกดลงชื่อใหม่ได้เลย!'));
        }

        // ── ยกเลิกการลงชื่อ ────────────────────────────────
        else if (action === 'leave') {
            let removed = false;

            if (event.participants.includes(userTag)) {
                event.participants.splice(event.participants.indexOf(userTag), 1);
                // เลื่อนคนแรกในคิวรอขึ้นตัวจริง
                const nextIdx = event.waitingList.findIndex(p => p.wantMain);
                if (nextIdx !== -1) {
                    const promoted = event.waitingList.splice(nextIdx, 1)[0];
                    event.participants.push(promoted.userTag);
                }
                removed = true;
            } else {
                const idx = event.waitingList.findIndex(p => p.userTag === userTag);
                if (idx !== -1) {
                    event.waitingList.splice(idx, 1); removed = true;
                }
            }

            if (!removed) return interaction.reply(E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
            await event.save();
            await interaction.reply(E('👋 ยกเลิกการลงชื่อเรียบร้อย เปลี่ยนใจเมื่อไหร่ก็ลงใหม่ได้นะ~'));
        }

        // อัปเดต embed ในข้อความที่แสดงปุ่ม
        try {
            const latest = await Event.findOne({
                eventId
            });
            await interaction.message.edit({
                embeds: [await buildEventEmbed(latest, interaction.guild)]
            });
        } catch {
            /* หา message ไม่เจอก็ข้ามไป */
        }
    });



    // ════════════════════════════════════════════════════════
    //  ERROR HANDLER
    // ════════════════════════════════════════════════════════

    // ── ปุ่มเปลี่ยนหน้า checkin ──────────────────────────
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('checkin_page||')) return;

        const parts   = interaction.customId.split('||');
        const eventId = parts[1];
        const page    = parseInt(parts[2]);

        const event = await Event.findOne({ eventId });
        if (!event) {
            try { return await interaction.update({ content: '😕 หากิจกรรมนี้ไม่เจอแล้ว', components: [], embeds: [] }); }
            catch { return await interaction.reply(E('😕 หากิจกรรมนี้ไม่เจอแล้ว')); }
        }

        const pageData = await buildCheckinPage(interaction, event, page);
        try { return await interaction.update(pageData); }
        catch { return await interaction.reply(pageData); }
    });

    process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

    client.login(BOT_TOKEN);