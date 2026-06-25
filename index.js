require('dotenv').config();

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
//  GLOBAL ERROR HANDLERS
// ════════════════════════════════════════════════════════
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

// ════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGOTOKEN;
let mainGuildId  = null; // เก็บ Guild ID หลักตอนบอทเปิด
const MEMBER_ROLE_ID         = '1472776595554042049';
const RENAME_LOG_CHANNEL_ID  = '1507318365864071178'; // channel สำหรับ log การเปลี่ยนชื่อ

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
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ════════════════════════════════════════════════════════
//  COOLDOWN
// ════════════════════════════════════════════════════════
const cooldownMap = new Map();
const robloxListCache = new Map(); // cache สำหรับ /robloxlist pagination
const robloxListTimers = new Map(); // timer สำหรับ expire cache

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
        guildId:         { type: String, default: null },
        discordId:       { type: String, unique: true },
        robloxId:        String,
        robloxUsername:  String,
        lastDisplayName: String,
        birthday:        { type: String, default: null }, // รูปแบบ DD-MM
    }));

    // ─── Schema: Multi-Group Tracker ─────────────────────────
    // ติดตามสถานะการเข้ากลุ่ม Roblox ของผู้เล่นที่ลงทะเบียนไว้แล้ว (RobloxSync)
    const GroupTracker = mongoose.model('GroupTracker', new mongoose.Schema({
        discordId: { type: String, required: true, unique: true },
        robloxId:  { type: String, required: true },
        groups: [{
            groupId:   { type: String, required: true },
            groupName: { type: String, default: null },
            status:    { type: String, enum: ['pending', 'joined'], default: 'pending' },
            joinedAt:  { type: Date, default: null },
            addedAt:   { type: Date, default: Date.now },
        }],
    }));

    // ─── Schema: รายการกลุ่มที่แอดมินเปิด track แบบ global ─────
    // ทุกครั้งที่แอดมินเพิ่มกลุ่มที่นี่ ระบบจะ sync ให้สมาชิกทุกคนใน RobloxSync โดยอัตโนมัติ
    // และสมาชิกใหม่ที่ /register ทีหลังก็จะถูกเพิ่มเข้า track กลุ่มเหล่านี้ให้ทันที
    const TrackedGroups = mongoose.model('TrackedGroups', new mongoose.Schema({
        groupId:   { type: String, required: true, unique: true },
        groupName: { type: String, default: null },
        addedAt:   { type: Date, default: Date.now },
        addedBy:   { type: String, default: null }, // discordId ของแอดมินที่เพิ่ม
    }));

    // ─── Schema: ร้านเติม (Shop) — รวมหลายกลุ่มเข้าด้วยกัน ─────
    // กลุ่มเดียวอยู่ได้หลายร้านพร้อมกัน เช่น "SULU KAKA" อยู่ทั้ง Group A และ Group B
    const Shop = mongoose.model('Shop', new mongoose.Schema({
        // ไม่ใส่ unique: true เพราะ MongoDB unique index เป็น case-sensitive แต่แอปเช็คชื่อซ้ำแบบไม่สนตัวพิมพ์ใหญ่เล็ก (ดู addshop/renameshop)
        // ถ้าใส่ unique ตรงนี้จะทำให้ "Group A" กับ "group a" ถูกมองว่าต่างกัน เปิดช่องให้สร้างซ้ำได้ผ่าน race condition
        shopName: { type: String, required: true },
        groupIds: { type: [String], default: [] },
        createdAt: { type: Date, default: Date.now },
        createdBy: { type: String, default: null },
    }));

    // ─── Schema: ห้องที่ถูกล็อค (persist กันบอท restart แล้วปลดล็อคโดยไม่รู้ตัว) ─────
    const LockedChannel = mongoose.model('LockedChannel', new mongoose.Schema({
        channelId: { type: String, required: true, unique: true },
        lockedBy:  { type: String, default: null },
        lockedAt:  { type: Date, default: Date.now },
    }));

    // ════════════════════════════════════════════════════════
    //  HELPERS
    // ════════════════════════════════════════════════════════
    // Wrapper เรียก Roblox API ทุกจุดในไฟล์ — รวม URL ไว้ที่เดียวกันหมด กันบัค URL พิมพ์ผิดแบบที่เคยเกิด (404 ทั้ง batch)
    // และจัดการ retry แบบ exponential backoff เมื่อโดน rate limit (HTTP 429) แทนที่จะข้ามไปเฉยๆ
    // คืนค่า: { ok, status, data } เสมอ — ไม่ throw ยกเว้น network error จริงๆ (เช่น DNS ล่ม) ซึ่งจะถูก catch ไว้แล้วคืน ok: false
    async function fetchRobloxAPI(url, { maxRetries = 3 } = {}) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url);

                if (res.status === 429) {
                    if (attempt === maxRetries) {
                        console.log(`[ROBLOX-API] ⚠️ โดน rate limit (429) ครบ ${maxRetries} ครั้งแล้ว ข้าม: ${url}`);
                        return { ok: false, status: 429, data: null };
                    }
                    // อ่าน Retry-After header ถ้ามี ไม่มีก็ใช้ exponential backoff (1s, 2s, 4s...)
                    const retryAfterHeader = res.headers.get('retry-after');
                    const waitMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : (1000 * Math.pow(2, attempt));
                    console.log(`[ROBLOX-API] ⏳ โดน rate limit (429) รอ ${Math.round(waitMs)}ms แล้ว retry (ครั้งที่ ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                if (!res.ok) return { ok: false, status: res.status, data: null };

                const data = await res.json();
                return { ok: true, status: res.status, data };
            } catch (err) {
                if (attempt === maxRetries) {
                    console.error(`[ROBLOX-API] error เรียก API ไม่สำเร็จหลัง retry ${maxRetries} ครั้ง: ${err.message}`);
                    return { ok: false, status: null, data: null };
                }
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
        }
        return { ok: false, status: null, data: null }; // เผื่อไว้ ไม่ควรมาถึงจริง
    }

    // เพิ่มกลุ่มเดียว ให้ผู้ใช้คนเดียวเข้า GroupTracker แบบเร็ว (ใส่ pending เสมอ)
    // ไม่เช็ค Roblox API ตรงนี้ เพื่อให้ /register และ /addgroup ตอบกลับเร็ว — ปล่อยให้ checkGroupStatus() แบบ batch จัดการเช็คสถานะจริงทีหลัง
    // กันซ้ำ: ถ้ามี groupId นี้อยู่แล้วใน array จะไม่เพิ่มซ้ำ
    async function addGroupToUserTracker(discordId, robloxId, groupId, groupName) {
        const tracker = await GroupTracker.findOneAndUpdate(
            { discordId },
            { $setOnInsert: { discordId, robloxId, groups: [] } },
            { upsert: true, returnDocument: 'after' }
        );
        if (tracker.groups.some(g => g.groupId === groupId)) return false; // มีอยู่แล้ว ข้าม
        tracker.groups.push({ groupId, groupName, status: 'pending', joinedAt: null });
        tracker.robloxId = robloxId; // กันกรณี robloxId เปลี่ยนหลัง re-register
        await tracker.save();
        return true;
    }

    const E = (msg) => ({
        content: msg, flags: [MessageFlags.Ephemeral]
    });

    // ── safeReply: ป้องกัน DiscordAPIError[40060] ──────────
    // ใช้แทน interaction.reply() ทุกจุดที่อาจเกิด double-acknowledge
    async function safeReply(interaction, options) {
        try {
            if (interaction.replied || interaction.deferred) {
                return await interaction.followUp(options);
            }
            return await interaction.reply(options);
        } catch (err) {
            // 40060 = already acknowledged, 10062 = unknown interaction (หมดอายุ)
            if (err?.code !== 40060 && err?.code !== 10062) throw err;
        }
    }

    function hasPermission(member) {
        return member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id)) || member.permissions.has('Administrator');
    }

    function getUserTag(member, user) {
        return user.id; // เก็บ userId เพื่อ tag และ match ได้ถูกต้อง
    }

    // ── ส่ง log การเปลี่ยนชื่อ ─────────────────────────────
    async function sendRenameLog(guildObj, oldName, newName, reason = '') {
        const logChannel = guildObj.channels.cache.get(RENAME_LOG_CHANNEL_ID);
        if (!logChannel) return;
        const embed = new EmbedBuilder()
            .setTitle('✏️ เปลี่ยนชื่อสมาชิก')
            .setDescription(`**${oldName}** ➜ **${newName}**`)
            .addFields({ name: '📌 สาเหตุ', value: reason || 'ไม่ระบุ' })
            .setColor(0xFEE75C)
            .setTimestamp();
        await logChannel.send({ embeds: [embed] }).catch(() => {});
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

        // ดึง member จาก guild เพื่อเอาชื่อจริง
        const guild = interaction.guild;
        const memberMap = new Map();
        try {
            const ids = pagePeople.map(p => stripMention(p.userTag)).filter(id => /^\d{17,20}$/.test(id));
            await Promise.all(ids.map(id =>
                guild.members.fetch(id).then(m => memberMap.set(id, m)).catch(() => {})
            ));
        } catch { /* ใช้ ID เป็น fallback */ }

        const getLabel = (userTag) => {
            const id = stripMention(userTag);
            const m  = memberMap.get(id);
            return m ? m.displayName.substring(0, 25) : id.substring(0, 25);
        };

        const options = pagePeople.map(({ userTag, type }) => ({
            label:       (attended.includes(userTag) ? '✅ ' : '') + getLabel(userTag),
            description: `${typeLabel[type]}  •  ${attended.includes(userTag) ? 'เช็คแล้ว' : 'ยังไม่ได้เช็ค'}`,
            value:       `${event.eventId}||${userTag}`.substring(0, 100),
        }));

        const checkedOptions = pagePeople
            .filter(({ userTag }) => attended.includes(userTag))
            .map(({ userTag, type }) => ({
                label:       '✅ ' + getLabel(userTag),
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

        console.log('--- รายชื่อ Guild ID ทั้งหมด ---');
        client.guilds.cache.forEach(guild => {
            console.log(`ชื่อเซิร์ฟเวอร์: ${guild.name} | ID: ${guild.id}`);
        });
        console.log('----------------------------');
        const firstGuild = client.guilds.cache.first();
        mainGuildId = process.env.GUILD_ID || (firstGuild ? firstGuild.id : null);
        console.log(`🏠 Guild หลัก: ${mainGuildId}`);

        try {
            if (!MONGO_URI) throw new Error('ไม่เจอตัวแปร MONGOTOKEN');
            await mongoose.connect(MONGO_URI, {
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
            });
            mongoose.connection.on('disconnected', () => {
                console.warn('⚠️ MongoDB หลุด กำลัง reconnect...');
            });
            mongoose.connection.on('reconnected', () => {
                console.log('✅ MongoDB reconnect สำเร็จ');
            });
            mongoose.connection.on('error', (err) => {
                console.error('❌ MongoDB error:', err.message);
            });
            console.log('🍃 ต่อ MongoDB สำเร็จ!');

            // โหลดห้องที่ล็อคไว้ก่อนหน้ากลับเข้า memory (กันบอท restart แล้วห้องปลดล็อคโดยไม่รู้ตัว)
            try {
                const locked = await LockedChannel.find({});
                locked.forEach(l => protectedChannels.add(l.channelId));
                console.log(`🔒 โหลดห้องที่ล็อคไว้กลับมา ${locked.length} ห้อง`);
            } catch (err) {
                console.error('❌ โหลด LockedChannel ไม่ได้:', err.message);
            }
        } catch (err) {
            console.error('❌ ต่อ MongoDB ไม่ได้:', err.message);
        }

        // ── Register Slash Commands ──────────────────────────
        try {
            const rest   = new REST({ version: '10' }).setToken(BOT_TOKEN);
            const guilds = client.guilds.cache.map(g => g.id);
            for (const guildId of guilds) {
                await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
            }
            console.log('✅ Register Slash Commands สำเร็จ!');
        } catch (err) {
            console.error('❌ Register Slash Commands ไม่ได้:', err.message);
        }

        // Roblox Sync — เช็ค Display Name ทุก 10 นาที แบ่ง batch 10 คน/รอบ
        let syncBatchIndex = 0;
        setInterval(async () => {
            console.log(`[SYNC] เริ่ม sync รอบใหม่ — ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`);
            try {
                const syncs = await RobloxSync.find({});
                const BATCH_SIZE = 10;
                const totalBatches = Math.ceil(syncs.length / BATCH_SIZE);

                // หมุน batch index วนซ้ำ
                if (syncBatchIndex >= totalBatches) syncBatchIndex = 0;

                const batchStart = syncBatchIndex * BATCH_SIZE;
                const batch = syncs.slice(batchStart, batchStart + BATCH_SIZE);

                console.log(`[SYNC] พบ ${syncs.length} คน | batch ${syncBatchIndex + 1}/${totalBatches} (คนที่ ${batchStart + 1}-${batchStart + batch.length})`);
                syncBatchIndex++;

                for (const sync of batch) {
                    try {
                        console.log(`[SYNC] กำลังเช็ค discordId: ${sync.discordId} | robloxId: ${sync.robloxId}`);
                        const { ok, status, data } = await fetchRobloxAPI(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                        await new Promise(r => setTimeout(r, 500));
                        if (!ok || !data || !data.displayName) {
                            console.log(`[SYNC] ⚠️ ดึงข้อมูล Roblox ไม่ได้ (${sync.robloxId}) | HTTP: ${status} | response: ${JSON.stringify(data)}`);
                            continue;
                        }
                        console.log(`[SYNC] Roblox displayName: "${data.displayName}" | DB lastDisplayName: "${sync.lastDisplayName}"`);
                        if (!data.displayName.toUpperCase().startsWith('ORION')) {
                            console.log(`[SYNC] ⛔ ข้าม — ชื่อไม่ขึ้นต้นด้วย ORION: "${data.displayName}"`);
                            continue;
                        }

                        const targetGuildId = sync.guildId || mainGuildId;
                        const guild  = client.guilds.cache.get(targetGuildId);
                        if (!guild) { console.log(`[SYNC] ⚠️ หา guild ไม่เจอ (guildId=${targetGuildId})`); continue; }
                        console.log(`[SYNC] ใช้ guild: ${guild.name} (${guild.id})`);
                        const member = await guild.members.fetch(sync.discordId).catch(() => null);
                        if (!member) { console.log(`[SYNC] ⚠️ หา member ไม่เจอ (${sync.discordId})`); continue; }

                        const currentName   = member.displayName;
                        const bracketMatch  = currentName.match(/[(](.+)[)]$/);
                        const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
                        const finalName     = `${data.displayName} (${bracketSuffix})`;

                        // เปลี่ยนถ้า: Roblox displayName เปลี่ยน หรือ Discord nickname ปัจจุบันไม่ตรงกับที่ควรเป็น
                        const nameChanged   = data.displayName !== sync.lastDisplayName;
                        // เทียบจากชื่อ Discord ปัจจุบันจริงๆ (member.displayName) แทนการเทียบจาก DB เพื่อจับกรณีถูกแก้ชื่อมือ
                        const nicknameWrong = member.displayName !== finalName;
                        console.log(`[SYNC] Discord nickname ปัจจุบัน: "${member.displayName}" | ควรเป็น: "${finalName}"`);
                        console.log(`[SYNC] nameChanged=${nameChanged} | nicknameWrong=${nicknameWrong}`);
                        if (!nameChanged && !nicknameWrong) {
                            console.log(`[SYNC] ✅ ข้าม — ทุกอย่างถูกต้องแล้ว`);
                            continue;
                        }

                        const oldNickname = member.displayName;
                        await member.setNickname(finalName).catch((err) => {
                            console.error(`[ERROR] setNickname ไม่ได้ (${sync.discordId}): ${err.message}`);
                        });
                        sync.lastDisplayName = data.displayName;
                        await sync.save();
                        console.log(`🔄 เปลี่ยนชื่อ ${sync.discordId} → ${finalName}`);
                        await sendRenameLog(guild, oldNickname, finalName, '🔄 Roblox Display Name เปลี่ยน (อัตโนมัติ)');
                    } catch (err) {
                        console.error(`[ERROR] sync ล้มเหลว (${sync.discordId}): ${err.message}`);
                    }

                    // delay 1500ms ต่อคน กันโดน rate limit
                    await new Promise(r => setTimeout(r, 1500));
                }
            } catch (err) {
                console.error(`[ERROR] sync DB ล้มเหลว: ${err.message}`);
            }
            console.log(`[SYNC] จบรอบ sync — ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`);
        }, 10 * 60_000);

        // ── Multi-Group Tracker — เช็คสถานะเข้ากลุ่ม Roblox ทุก 10 นาที แบบ batch 10 คน/รอบ ──
        // เช็คเฉพาะ pending entry เท่านั้น (ไม่ยุ่งกับกลุ่มที่ joined แล้ว) ป้องกัน rate limit ด้วย delay ต่อรายการ + batch
        let groupTrackBatchIndex = 0;
        const checkGroupStatus = async () => {
            console.log(`[GROUPTRACK] เริ่มเช็คกลุ่ม — ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`);
            try {
                // ดึงเฉพาะ tracker ที่มี group สถานะ pending อยู่อย่างน้อย 1 กลุ่ม
                const allPending = await GroupTracker.find({ 'groups.status': 'pending' });
                const BATCH_SIZE = 10;
                const totalBatches = Math.ceil(allPending.length / BATCH_SIZE);

                if (totalBatches === 0) {
                    console.log(`[GROUPTRACK] ไม่มีใคร pending อยู่ ข้ามรอบนี้`);
                    return;
                }

                if (groupTrackBatchIndex >= totalBatches) groupTrackBatchIndex = 0;
                const batchStart = groupTrackBatchIndex * BATCH_SIZE;
                const trackers   = allPending.slice(batchStart, batchStart + BATCH_SIZE);

                console.log(`[GROUPTRACK] พบ ${allPending.length} คนที่มีกลุ่ม pending อยู่ | batch ${groupTrackBatchIndex + 1}/${totalBatches} (คนที่ ${batchStart + 1}-${batchStart + trackers.length})`);
                groupTrackBatchIndex++;

                // ดึง RobloxSync ของคนใน batch นี้มาเก็บไว้ล่วงหน้า เพื่อโชว์ Display Name ใน log แทน discordId ดิบๆ
                const batchDiscordIds = trackers.map(t => t.discordId);
                const syncDocs = await RobloxSync.find({ discordId: { $in: batchDiscordIds } });
                const displayNameMap = new Map(syncDocs.map(s => [s.discordId, s.lastDisplayName || s.robloxUsername || s.discordId]));

                for (const tracker of trackers) {
                    const pendingGroups = tracker.groups.filter(g => g.status === 'pending');
                    const displayName = displayNameMap.get(tracker.discordId) || tracker.discordId;

                    for (const g of pendingGroups) {
                        const groupLabel = g.groupName || g.groupId;
                        try {
                            const { ok, status, data } = await fetchRobloxAPI(`https://groups.roblox.com/v1/users/${tracker.robloxId}/groups/roles`);
                            if (!ok) {
                                console.log(`[GROUPTRACK] ⚠️ ดึงข้อมูลกลุ่มไม่ได้ (robloxId=${tracker.robloxId}) | HTTP: ${status}`);
                            } else {
                                const isMember = Array.isArray(data?.data) && data.data.some(entry => String(entry.group?.id) === g.groupId);

                                if (isMember) {
                                    g.status   = 'joined';
                                    g.joinedAt = new Date();
                                    console.log(`[GROUPTRACK] ✅ ${displayName} (robloxId=${tracker.robloxId}) เข้ากลุ่ม ${groupLabel} แล้ว`);
                                } else {
                                    console.log(`[GROUPTRACK] ⏳ ${displayName} (robloxId=${tracker.robloxId}) ยังไม่เข้ากลุ่ม ${groupLabel}`);
                                }
                            }
                        } catch (err) {
                            console.error(`[GROUPTRACK] error เช็คกลุ่ม ${groupLabel} ของ ${displayName}: ${err.message}`);
                        }

                        // delay กันโดน rate limit ของ Roblox Groups API
                        await new Promise(r => setTimeout(r, 1500));
                    }

                    // save แยก try/catch ของตัวเอง — ถ้า save ล้มเหลวไม่ให้กระทบ tracker คนถัดไปใน loop
                    try {
                        await tracker.save();
                    } catch (err) {
                        console.error(`[GROUPTRACK] บันทึก DB ไม่ได้ (${tracker.discordId}): ${err.message}`);
                    }
                }
            } catch (err) {
                console.error(`[GROUPTRACK] error: ${err.message}`);
            }
            console.log(`[GROUPTRACK] จบรอบเช็คกลุ่ม — ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`);
        };
        setInterval(checkGroupStatus, 10 * 60_000);

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
            .setName('robloxlist')
            .setDescription('ดึงรายชื่อ Roblox ของสมาชิกทุกคนที่ลงทะเบียนแล้ว'),
        new SlashCommandBuilder()
            .setName('robloxinfo')
            .setDescription('ดูข้อมูล Roblox ของสมาชิกคนที่ระบุ')
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่ต้องการดู').setRequired(true)),
        new SlashCommandBuilder()
            .setName('myprofile')
            .setDescription('ดูข้อมูลของตัวเองที่ลงทะเบียนไว้'),
        new SlashCommandBuilder()
            .setName('memberlist')
            .setDescription('ดูรายชื่อสมาชิกที่ลงทะเบียนแล้วและยังไม่ได้ลงทะเบียน'),
        new SlashCommandBuilder()
            .setName('birthdays')
            .setDescription('ดูวันเกิดที่กำลังจะมาถึงในเดือนนี้'),
        new SlashCommandBuilder()
            .setName('setbirthday')
            .setDescription('ตั้งหรือแก้ไขวันเกิดของตัวเอง')
            .addStringOption(o => o.setName('birthday').setDescription('วันเกิด เช่น 25/12').setRequired(true)),
        new SlashCommandBuilder()
            .setName('forcesyncroblox')
            .setDescription('บังคับ sync Roblox ของสมาชิกทันที')
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่ต้องการ sync').setRequired(true)),
        new SlashCommandBuilder()
            .setName('addgroup')
            .setDescription('[แอดมิน] เพิ่มกลุ่ม Roblox เข้าระบบติดตาม จะเช็คให้สมาชิกทุกคนที่ลงทะเบียนไว้ทันที')
            .addStringOption(o => o.setName('groupid').setDescription('Group ID ของกลุ่ม Roblox ที่ต้องการติดตาม').setRequired(true))
            .addStringOption(o => o.setName('groupname').setDescription('ตั้งชื่อกลุ่มเอง (ไม่ใส่ = ดึงชื่อจริงจาก Roblox อัตโนมัติ)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('addshop')
            .setDescription('[แอดมิน] เพิ่มกลุ่ม Roblox เข้าร้านเติม (สร้างร้านใหม่อัตโนมัติถ้ายังไม่มี)')
            .addStringOption(o => o.setName('shopname').setDescription('ชื่อร้านเติม เช่น Group A').setRequired(true))
            .addStringOption(o => o.setName('groupid').setDescription('เลือกกลุ่มที่ต้องการเพิ่มเข้าร้านนี้ (ต้อง /addgroup ไว้ก่อนแล้ว)').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName('removeshop')
            .setDescription('[แอดมิน] ลบกลุ่มออกจากร้านเติม หรือลบทั้งร้าน')
            .addStringOption(o => o.setName('shopname').setDescription('ชื่อร้านเติม').setRequired(true))
            .addStringOption(o => o.setName('groupid').setDescription('เลือกกลุ่มที่จะลบ (ไม่ใส่ = ลบทั้งร้าน)').setRequired(false).setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName('renameshop')
            .setDescription('[แอดมิน] เปลี่ยนชื่อร้านเติม')
            .addStringOption(o => o.setName('shopname').setDescription('ชื่อร้านปัจจุบัน').setRequired(true))
            .addStringOption(o => o.setName('newname').setDescription('ชื่อใหม่').setRequired(true)),
        new SlashCommandBuilder()
            .setName('groupstatus')
            .setDescription('เช็คสถานะการเข้ากลุ่ม Roblox และนับวันว่าเติมได้แล้วหรือยัง')
            .addUserOption(o => o.setName('user').setDescription('สมาชิกที่ต้องการดู (ไม่ใส่ = ตัวเอง)').setRequired(false))
            .addStringOption(o => o.setName('groupid').setDescription('ระบุ Group ID ถ้า track ไว้หลายกลุ่ม (ไม่ใส่ = กลุ่มแรก)').setRequired(false))
            .addStringOption(o => o.setName('shop').setDescription('ระบุชื่อร้านเติม เพื่อดูเฉพาะกลุ่มในร้านนั้น').setRequired(false).setAutocomplete(true)),
    ].map(c => c.toJSON());


        // ── Birthday Check — เช็คทุกวัน 00:00 น. เวลาไทย ──────
        const BIRTHDAY_CHANNEL_ID = '1513821672371781703';
        const checkBirthday = async () => {
            try {
                const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));

                // วันนี้
                const todayDD = String(now.getDate()).padStart(2, '0');
                const todayMM = String(now.getMonth() + 1).padStart(2, '0');
                const todayStr = `${todayDD}-${todayMM}`;

                // พรุ่งนี้
                const tomorrow = new Date(now);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowDD = String(tomorrow.getDate()).padStart(2, '0');
                const tomorrowMM = String(tomorrow.getMonth() + 1).padStart(2, '0');
                const tomorrowStr = `${tomorrowDD}-${tomorrowMM}`;

                const guild = client.guilds.cache.get(mainGuildId);
                if (!guild) return;

                const channel = guild.channels.cache.get(BIRTHDAY_CHANNEL_ID);
                if (!channel) return;

                // 🎉 แจ้งวันเกิดวันนี้
                const todaySyncs = await RobloxSync.find({ birthday: todayStr });
                for (const sync of todaySyncs) {
                    const member = await guild.members.fetch(sync.discordId).catch(() => null);
                    if (!member) continue;
                    await channel.send(`🎂 วันนี้วันเกิด ${member} แล้วน้าาา ~`);
                }

                // 🔔 แจ้งล่วงหน้า 1 วัน
                const tomorrowSyncs = await RobloxSync.find({ birthday: tomorrowStr });
                for (const sync of tomorrowSyncs) {
                    const member = await guild.members.fetch(sync.discordId).catch(() => null);
                    if (!member) continue;
                    await channel.send(`🎂 พรุ่งนี้วันเกิด ${member} แล้วนะ!`);
                }

                const total = todaySyncs.length + tomorrowSyncs.length;
                if (total) console.log(`[BIRTHDAY] เช็ควันเกิดเสร็จ — วันนี้ ${todaySyncs.length} คน, พรุ่งนี้ ${tomorrowSyncs.length} คน`);
            } catch (err) {
                console.error(`[BIRTHDAY] error: ${err.message}`);
            }
        };

        // รอจนถึง 00:00 น. เวลาไทยแล้วค่อย setInterval ทุก 24 ชั่วโมง
        const scheduleDaily = (fn) => {
            const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const msUntilMidnight = (
                (24 - now.getHours()) * 3600000 -
                now.getMinutes() * 60000 -
                now.getSeconds() * 1000 -
                now.getMilliseconds()
            ) % 86400000 || 86400000;
            console.log(`[BIRTHDAY] จะเช็คครั้งแรกใน ${Math.round(msUntilMidnight / 60000)} นาที`);
            setTimeout(() => {
                fn();
                setInterval(fn, 24 * 60 * 60 * 1000);
            }, msUntilMidnight);
        };
        scheduleDaily(checkBirthday);

    // ── Register Slash Commands ถูกย้ายเข้าใน clientReady ด้านบนแล้ว ──


    // ── Auto ลบ DB เมื่อสมาชิกออกจาก server ────────────────
    client.on('guildMemberRemove', async (member) => {
        try {
            const sync = await RobloxSync.findOneAndDelete({ discordId: member.id });
            if (sync) {
                console.log(`[LEAVE] ลบข้อมูล DB ของ ${member.user.tag} (${member.id}) | Roblox: ${sync.lastDisplayName}`);
                // ส่ง log ไปช่อง rename log ถ้ามี
                const logChannel = member.guild.channels.cache.find(c => c.name.includes('log') || c.name.includes('rename'));
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🚪 สมาชิกออกจาก Server')
                        .setDescription(
                            `👤 **Discord:** ${member.user.tag} (${member.id})\n` +
                            `🎮 **Roblox:** ${sync.lastDisplayName}\n` +
                            `🗑️ **ลบข้อมูลออกจาก DB แล้ว**`
                        )
                        .setColor(0xED4245)
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(() => {});
                }
            }
        } catch (err) {
            console.error(`[LEAVE] error: ${err.message}`);
        }
    });

    // ── Utility: fetch syncs + members in one go ────────────
    const fetchAllSyncs = async (guild) => {
        await guild.members.fetch();
        const syncs = await RobloxSync.find({});
        return syncs.map(sync => ({
            sync,
            member: guild.members.cache.get(sync.discordId) || null
        }));
    };

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
    // ── Autocomplete: groupid สำหรับ /addshop, /removeshop ──────
    // โชว์รายการกลุ่มที่ /addgroup ไว้แล้ว (ชื่อกลุ่ม + groupId) ให้เลือกแทนพิมพ์เลขเอง
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isAutocomplete()) return;
        if (!['addshop', 'removeshop'].includes(interaction.commandName)) return;
        if (interaction.options.getFocused(true).name !== 'groupid') return;

        try {
            const typed = interaction.options.getFocused().toLowerCase();
            let choicesSource;

            if (interaction.commandName === 'addshop') {
                // /addshop: เลือกจากกลุ่มทั้งหมดที่ track ไว้ (TrackedGroups)
                choicesSource = await TrackedGroups.find({}).limit(100);
            } else {
                // /removeshop: เลือกจากกลุ่มที่อยู่ใน "ร้านนี้" เท่านั้น (ตาม shopname ที่กรอกไปแล้ว)
                const shopNameInput = interaction.options.getString('shopname');
                if (!shopNameInput) return interaction.respond([]);
                const shop = await Shop.findOne({ shopName: { $regex: `^${shopNameInput.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
                if (!shop || shop.groupIds.length === 0) return interaction.respond([]);
                choicesSource = await TrackedGroups.find({ groupId: { $in: shop.groupIds } });
            }

            const filtered = choicesSource
                .filter(g => !typed || g.groupId.includes(typed) || (g.groupName || '').toLowerCase().includes(typed))
                .slice(0, 25) // Discord จำกัดสูงสุด 25 choices
                .map(g => {
                    const label = g.groupName ? `${g.groupName} (${g.groupId})` : g.groupId;
                    return { name: label.slice(0, 100), value: g.groupId }; // Discord จำกัดชื่อ choice ไม่เกิน 100 ตัวอักษร
                });

            await interaction.respond(filtered);
        } catch (err) {
            console.error(`[AUTOCOMPLETE] error: ${err.message}`);
            try { await interaction.respond([]); } catch {}
        }
    });

    // ── Autocomplete: shop สำหรับ /groupstatus ──────
    // โชว์รายการร้านเติมที่มีอยู่จริง (จาก Shop) ให้เลือกแทนพิมพ์ชื่อเอง
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== 'groupstatus') return;
        if (interaction.options.getFocused(true).name !== 'shop') return;

        try {
            const typed = interaction.options.getFocused().toLowerCase();
            const shops = await Shop.find({}).limit(100);

            const filtered = shops
                .filter(s => !typed || s.shopName.toLowerCase().includes(typed))
                .slice(0, 25) // Discord จำกัดสูงสุด 25 choices
                .map(s => ({ name: s.shopName.slice(0, 100), value: s.shopName }));

            await interaction.respond(filtered);
        } catch (err) {
            console.error(`[AUTOCOMPLETE] error: ${err.message}`);
            try { await interaction.respond([]); } catch {}
        }
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName, member, channel, guild } = interaction;

        // /setup
        if (commandName === 'setup') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            const embed = new EmbedBuilder()
                .setTitle('📅 ระบบจัดการกิจกรรม')
                .setDescription('อยากจัดการหรืออยากลงชื่อเข้าร่วมก็กดได้เลย 👇\n\n🛠️ หากระบบมีปัญหาติดต่อผู้พัฒนา: <@360498353462575115>')
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
            await LockedChannel.findOneAndUpdate(
                { channelId: channel.id },
                { channelId: channel.id, lockedBy: interaction.user.id },
                { upsert: true }
            ).catch(err => console.error(`[LOCK] บันทึก DB ไม่ได้ (setup): ${err.message}`));
            return interaction.reply({ content: '✅ สร้างแผงกิจกรรมแล้ว!', flags: [MessageFlags.Ephemeral] });
        }

        // /lock
        if (commandName === 'lock') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
            protectedChannels.add(channel.id);
            await LockedChannel.findOneAndUpdate(
                { channelId: channel.id },
                { channelId: channel.id, lockedBy: interaction.user.id },
                { upsert: true }
            ).catch(err => console.error(`[LOCK] บันทึก DB ไม่ได้: ${err.message}`));
            return interaction.reply({ content: '🔒 ล็อค channel นี้แล้ว! ข้อความจากสมาชิกจะถูกลบอัตโนมัติ', flags: [MessageFlags.Ephemeral] });
        }

        // /unlock
        if (commandName === 'unlock') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
            protectedChannels.delete(channel.id);
            await LockedChannel.deleteOne({ channelId: channel.id }).catch(err => console.error(`[UNLOCK] ลบ DB ไม่ได้: ${err.message}`));
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
                { guildId: interaction.guild.id, discordId: targetMember.id, robloxId, robloxUsername, lastDisplayName: displayName },
                { upsert: true }
            );

            const currentName   = targetMember.displayName;
            const bracketMatch  = currentName.match(/\((.+)\)$/);
            const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
            const finalName     = `${displayName} (${bracketSuffix})`;
            await targetMember.setNickname(finalName).catch((err) => {
                console.error(`[REGISTER] setNickname ไม่ได้ (${targetMember.id}): ${err.message}`);
            });

            return interaction.editReply(`✅ ลงทะเบียน **${targetMember.displayName}** กับ Username **${robloxUsername}** เรียบร้อย! เปลี่ยนชื่อเป็น **${finalName}** แล้ว บอทจะเช็คชื่อทุก 5 นาทีนะ`);
        }

        // /robloxlist — ดึงรายชื่อทุกคน
        if (commandName === 'robloxlist') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const allSyncs = await fetchAllSyncs(interaction.guild);
            if (!allSyncs.length)
                return interaction.editReply('😅 ยังไม่มีสมาชิกลงทะเบียนเลย');

            const lines = allSyncs.map(({ sync, member }) => {
                const discordName = member ? member.displayName : `<@${sync.discordId}>`;
                return `**${discordName}**
🎮 Roblox Username: \`${sync.robloxUsername || sync.lastDisplayName}\``;
            });

            // แบ่งหน้าถ้าเกิน 10 คน
            const PAGE = 10;
            const pages = [];
            for (let i = 0; i < lines.length; i += PAGE)
                pages.push(lines.slice(i, i + PAGE).join("\n\n"));

            const embed = new EmbedBuilder()
                .setTitle(`📋 รายชื่อ Roblox ทั้งหมด (${allSyncs.length} คน)`)
                .setDescription(pages[0])
                .setColor(0x5865F2)
                .setFooter({ text: `หน้า 1/${pages.length}  •  ทั้งหมด ${allSyncs.length} คน` });

            // เก็บ pages ใน cache แทนการยัดใน customId (กัน error customId เกิน 100 ตัวอักษร)
            const cacheKey = `${interaction.user.id}_${Date.now()}`;
            robloxListCache.set(cacheKey, { pages, total: allSyncs.length });
            if (robloxListTimers.has(cacheKey)) clearTimeout(robloxListTimers.get(cacheKey));
            robloxListTimers.set(cacheKey, setTimeout(() => { robloxListCache.delete(cacheKey); robloxListTimers.delete(cacheKey); }, 10 * 60_000));

            const components = [];
            if (pages.length > 1) {
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`rlp||${cacheKey}||0`).setLabel('◀ ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    new ButtonBuilder().setCustomId(`rlp||${cacheKey}||1`).setLabel('▶ ถัดไป').setStyle(ButtonStyle.Secondary).setDisabled(pages.length <= 1),
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
                const { ok, data } = await fetchRobloxAPI(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                if (ok && data?.displayName) currentDisplayName = data.displayName;
            } catch { /* ใช้ค่าเดิมถ้า fetch ไม่ได้ */ }

            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

            const bdDisplay = sync.birthday
                ? (() => { const [d, m] = sync.birthday.split('-'); return `${d}/${m}`; })()
                : 'ไม่ได้ระบุ';

            const embed = new EmbedBuilder()
                .setTitle(`🎮 ข้อมูล Roblox ของ ${targetMember ? targetMember.displayName : targetUser.username}`)
                .setDescription(
                    `👤 **Discord:** <@${targetUser.id}>\n` +
                    `🎮 **Roblox ID:** \`${sync.robloxId}\`\n` +
                    `✨ **Display Name ปัจจุบัน:** ${currentDisplayName}\n` +
                    `🎂 **วันเกิด:** ${bdDisplay}\n` +
                    `🔗 **Profile:** [คลิกดูโปรไฟล์](${profileUrl})`
                )
                .setColor(0xFEE75C)
                .setFooter({ text: `ลงทะเบียนแล้ว • sync ทุก 5 นาที` });

            return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }


        // /myprofile
        if (commandName === 'myprofile') {
            const sync = await RobloxSync.findOne({ discordId: interaction.user.id });
            if (!sync)
                return interaction.reply({ content: '😕 คุณยังไม่ได้ลงทะเบียนเลย กดปุ่มลงทะเบียนก่อนนะ', flags: [MessageFlags.Ephemeral] });

            let currentDisplayName = sync.lastDisplayName;
            try {
                const { ok, data } = await fetchRobloxAPI(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                if (ok && data && data.displayName) currentDisplayName = data.displayName;
            } catch { /* ใช้ค่าเดิม */ }

            const bdDisplay = sync.birthday
                ? (() => { const [d, m] = sync.birthday.split('-'); return `${d}/${m}`; })()
                : 'ไม่ได้ระบุ';

            const embed = new EmbedBuilder()
                .setTitle(`👤 โปรไฟล์ของ ${member.displayName}`)
                .setDescription(
                    `🎮 **Roblox Username:** \`${sync.robloxUsername || '-'}\`\n` +
                    `✨ **Display Name:** ${currentDisplayName}\n` +
                    `🆔 **Roblox ID:** \`${sync.robloxId}\`\n` +
                    `🎂 **วันเกิด:** ${bdDisplay}\n` +
                    `🔗 **Profile:** [คลิกดูโปรไฟล์](https://www.roblox.com/users/${sync.robloxId}/profile)`
                )
                .setColor(0x57F287)
                .setFooter({ text: 'sync ทุก 5 นาที' });

            return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }


        // /memberlist
        if (commandName === 'memberlist') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const allData = await fetchAllSyncs(interaction.guild);
            const registeredIds = new Set(allData.map(({ sync }) => sync.discordId));

            const allMembers   = interaction.guild.members.cache.filter(m => !m.user.bot);
            const registered   = allMembers.filter(m => registeredIds.has(m.id));
            const unregistered = allMembers.filter(m => !registeredIds.has(m.id));

            const regList   = registered.map(m => `✅ ${m.displayName}`).join('\n') || 'ไม่มี';
            const unregList = unregistered.map(m => `❌ ${m.displayName}`).join('\n') || 'ไม่มี';

            const embed = new EmbedBuilder()
                .setTitle('📋 รายชื่อสมาชิก')
                .addFields(
                    { name: `✅ ลงทะเบียนแล้ว (${registered.size} คน)`, value: regList.slice(0, 1024) },
                    { name: `❌ ยังไม่ได้ลงทะเบียน (${unregistered.size} คน)`, value: unregList.slice(0, 1024) }
                )
                .setColor(0x5865F2)
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }


        // /birthdays
        if (commandName === 'birthdays') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const currentMM = String(now.getMonth() + 1).padStart(2, '0');

            const syncs = await RobloxSync.find({ birthday: { $regex: `-${currentMM}$` } });

            if (!syncs.length)
                return interaction.reply({ content: `😕 ไม่มีใครวันเกิดเดือนนี้เลย`, flags: [MessageFlags.Ephemeral] });

            // เรียงตามวัน
            syncs.sort((a, b) => parseInt(a.birthday) - parseInt(b.birthday));

            const lines = [];
            for (const sync of syncs) {
                const m = await interaction.guild.members.fetch(sync.discordId).catch(() => null);
                const [dd, mm] = sync.birthday.split('-');
                const name = m ? m.displayName : sync.lastDisplayName;
                const isToday = dd === String(now.getDate()).padStart(2, '0');
                const isTomorrow = dd === String(now.getDate() + 1).padStart(2, '0');
                const tag = isToday ? ' 🎉 วันนี้!' : isTomorrow ? ' 🎂 พรุ่งนี้!' : '';
                lines.push(`**${dd}/${mm}** — ${name}${tag}`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`🎂 วันเกิดเดือนนี้ (${syncs.length} คน)`)
                .setDescription(lines.join('\n'))
                .setColor(0xFEE75C)
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }


        // /setbirthday
        if (commandName === 'setbirthday') {
            const sync = await RobloxSync.findOne({ discordId: interaction.user.id });
            if (!sync)
                return interaction.reply({ content: '😕 คุณยังไม่ได้ลงทะเบียนเลย กดปุ่มลงทะเบียนก่อนนะ', flags: [MessageFlags.Ephemeral] });

            const birthdayRaw = interaction.options.getString('birthday').trim();
            const bdMatch = birthdayRaw.match(/^(\d{1,2})[/\-](\d{1,2})$/);
            if (!bdMatch)
                return interaction.reply({ content: '❌ รูปแบบวันเกิดไม่ถูกต้อง กรุณากรอกเป็น วว/ดด เช่น 25/12', flags: [MessageFlags.Ephemeral] });

            const dd = bdMatch[1].padStart(2, '0');
            const mm = bdMatch[2].padStart(2, '0');
            const birthday = `${dd}-${mm}`;

            await RobloxSync.findOneAndUpdate({ discordId: interaction.user.id }, { birthday });
            return interaction.reply({ content: `✅ บันทึกวันเกิด **${dd}/${mm}** เรียบร้อยแล้ว`, flags: [MessageFlags.Ephemeral] });
        }

        // /forcesyncroblox
        if (commandName === 'forcesyncroblox') {
            if (!hasPermission(member))
                return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const targetUser   = interaction.options.getUser('user');
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            if (!targetMember)
                return interaction.editReply('❌ หาสมาชิกคนนี้ไม่เจอในเซิร์ฟเวอร์');

            const sync = await RobloxSync.findOne({ discordId: targetUser.id });
            if (!sync)
                return interaction.editReply(`❌ ${targetMember.displayName} ยังไม่ได้ลงทะเบียนเลย`);

            try {
                const { ok, data } = await fetchRobloxAPI(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                if (!ok || !data || !data.displayName)
                    return interaction.editReply('❌ ดึงข้อมูล Roblox ไม่ได้ ลองใหม่ภายหลังนะ');

                if (!data.displayName.toUpperCase().startsWith('ORION'))
                    return interaction.editReply(`❌ Display Name บน Roblox ไม่ขึ้นต้นด้วย ORION: **${data.displayName}**`);

                const currentName   = targetMember.displayName;
                const bracketMatch  = currentName.match(/[(](.+)[)]$/);
                const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
                const finalName     = `${data.displayName} (${bracketSuffix})`;

                await targetMember.setNickname(finalName).catch((err) => {
                    console.error(`[FORCESYNC] setNickname ไม่ได้ (${targetUser.id}): ${err.message}`);
                });

                sync.lastDisplayName = data.displayName;
                await sync.save();

                console.log(`[FORCESYNC] ${targetUser.id} → ${finalName}`);
                await sendRenameLog(interaction.guild, currentName, finalName, '🔄 Force Sync โดยแอดมิน');
                return interaction.editReply(`✅ Sync สำเร็จ! เปลี่ยนชื่อ **${currentName}** → **${finalName}** แล้ว`);
            } catch (err) {
                console.error(`[FORCESYNC] error: ${err.message}`);
                return interaction.editReply(`❌ เกิดข้อผิดพลาด: ${err.message}`);
            }
        }

        // /addgroup — [แอดมิน] เพิ่มกลุ่ม Roblox เข้าระบบ track แบบ global แล้ว sync ให้ทุกคนใน RobloxSync ทันที
        if (commandName === 'addgroup') {
            if (!hasPermission(member))
                return safeReply(interaction, E('❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ'));

            const groupId      = interaction.options.getString('groupid').trim();
            const groupNameOpt = interaction.options.getString('groupname');

            if (!/^\d+$/.test(groupId))
                return safeReply(interaction, E('❌ Group ID ต้องเป็นตัวเลขเท่านั้น'));

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            try {
                const existingGroup = await TrackedGroups.findOne({ groupId });
                if (existingGroup)
                    return interaction.editReply(`⚠️ กลุ่ม **${existingGroup.groupName || groupId}** (\`${groupId}\`) ถูกเพิ่มเข้าระบบไปแล้ว`);

                // ถ้าไม่ตั้งชื่อเอง ให้ดึงชื่อจริงจาก Roblox Groups API มาเก็บไว้เลย (ครั้งเดียว)
                let groupName = groupNameOpt ? groupNameOpt.trim() : null;
                if (!groupName) {
                    try {
                        const { ok, status, data } = await fetchRobloxAPI(`https://groups.roblox.com/v1/groups/${groupId}`);
                        if (ok) {
                            if (data?.name) groupName = data.name;
                        } else {
                            console.log(`[ADDGROUP] ดึงชื่อกลุ่มไม่ได้ (groupId=${groupId}) | HTTP: ${status}`);
                        }
                    } catch (err) {
                        console.error(`[ADDGROUP] error ดึงชื่อกลุ่ม: ${err.message}`);
                    }
                }

                await TrackedGroups.create({ groupId, groupName, addedBy: interaction.user.id });

                // sync ให้ทุกคนที่ลงทะเบียน Roblox ไว้แล้วทันที (ใส่ pending ก่อน — checkGroupStatus() แบบ batch จะค่อยเช็คจริงทีหลัง)
                const allSyncs = await RobloxSync.find({});
                let addedCount = 0;
                for (const sync of allSyncs) {
                    const added = await addGroupToUserTracker(sync.discordId, sync.robloxId, groupId, groupName);
                    if (added) addedCount++;
                }

                console.log(`[ADDGROUP] เพิ่มกลุ่ม ${groupId} (${groupName || 'ไม่มีชื่อ'}) โดย ${interaction.user.id} | sync ให้ ${addedCount}/${allSyncs.length} คน`);
                return interaction.editReply(
                    `✅ เพิ่มกลุ่ม **${groupName || groupId}** (\`${groupId}\`) เข้าระบบติดตามแล้ว\n` +
                    `📋 เริ่ม track ให้สมาชิกที่ลงทะเบียนแล้ว **${addedCount}/${allSyncs.length} คน**\n` +
                    `⏳ ระบบจะไล่เช็คสถานะจริงเป็น batch ทุก 10 นาที (ใครอยู่ในกลุ่มอยู่แล้วจะขึ้น ✅ ในรอบของตัวเอง)\n` +
                    `✨ สมาชิกใหม่ที่ /register ทีหลัง จะถูกเพิ่มเข้า track กลุ่มนี้ให้อัตโนมัติด้วย`
                );
            } catch (err) {
                console.error(`[ADDGROUP] error: ${err.message}`);
                return interaction.editReply('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ');
            }
        }

        // /addshop — [แอดมิน] เพิ่มกลุ่มเข้าร้านเติม (สร้างร้านใหม่อัตโนมัติถ้ายังไม่มี)
        if (commandName === 'addshop') {
            if (!hasPermission(member))
                return safeReply(interaction, E('❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ'));

            try {
                const shopNameInput = interaction.options.getString('shopname').trim();
                const groupId       = interaction.options.getString('groupid').trim();

                if (!/^\d+$/.test(groupId))
                    return safeReply(interaction, E('❌ Group ID ต้องเป็นตัวเลขเท่านั้น'));

                // ต้อง /addgroup ไว้ก่อนแล้วเท่านั้น กันพิมพ์ groupId ผิดหรือกลุ่มที่ไม่ได้ track
                const trackedGroup = await TrackedGroups.findOne({ groupId });
                if (!trackedGroup)
                    return safeReply(interaction, E(`❌ กลุ่ม \`${groupId}\` ยังไม่ได้ /addgroup เข้าระบบ ต้องเพิ่มกลุ่มก่อนถึงจะเอามาจัดร้านได้`));

                // ค้นหาแบบไม่สนตัวพิมพ์ใหญ่เล็ก ("group a" = "Group A") แต่เก็บชื่อตามที่พิมพ์ครั้งแรกไว้แสดงผล
                const shopRegex = new RegExp(`^${shopNameInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
                let shop = await Shop.findOne({ shopName: shopRegex });

                if (!shop) {
                    shop = await Shop.create({ shopName: shopNameInput, groupIds: [groupId], createdBy: interaction.user.id });
                    console.log(`[ADDSHOP] สร้างร้านใหม่ "${shopNameInput}" พร้อมกลุ่ม ${groupId} โดย ${interaction.user.id}`);
                    return safeReply(interaction, E(`✅ สร้างร้าน **${shopNameInput}** ใหม่ พร้อมเพิ่มกลุ่ม **${trackedGroup.groupName || groupId}** เข้าไปแล้ว`));
                }

                if (shop.groupIds.includes(groupId))
                    return safeReply(interaction, E(`⚠️ กลุ่ม **${trackedGroup.groupName || groupId}** อยู่ในร้าน **${shop.shopName}** อยู่แล้ว`));

                // ใช้ findOneAndUpdate + $addToSet แทน push-then-save เพื่อกัน race condition (ข้อมูลหายถ้ามีคนกดพร้อมกัน)
                shop = await Shop.findOneAndUpdate(
                    { _id: shop._id },
                    { $addToSet: { groupIds: groupId } },
                    { returnDocument: 'after' }
                );
                console.log(`[ADDSHOP] เพิ่มกลุ่ม ${groupId} เข้าร้าน "${shop.shopName}" โดย ${interaction.user.id}`);
                return safeReply(interaction, E(`✅ เพิ่มกลุ่ม **${trackedGroup.groupName || groupId}** เข้าร้าน **${shop.shopName}** แล้ว (ตอนนี้มี ${shop.groupIds.length} กลุ่มในร้านนี้)`));
            } catch (err) {
                console.error(`[ADDSHOP] error: ${err.message}`);
                return safeReply(interaction, E('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ'));
            }
        }

        // /removeshop — [แอดมิน] ลบกลุ่มออกจากร้าน หรือลบทั้งร้าน
        if (commandName === 'removeshop') {
            if (!hasPermission(member))
                return safeReply(interaction, E('❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ'));

            try {
                const shopNameInput = interaction.options.getString('shopname').trim();
                const groupId       = interaction.options.getString('groupid');

                const shop = await Shop.findOne({ shopName: { $regex: `^${shopNameInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
                if (!shop)
                    return safeReply(interaction, E(`❌ ไม่พบร้าน **${shopNameInput}**`));

                if (!groupId) {
                    // ไม่ระบุ groupId → ลบทั้งร้าน
                    await Shop.deleteOne({ _id: shop._id });
                    console.log(`[REMOVESHOP] ลบร้าน "${shop.shopName}" ทั้งหมด โดย ${interaction.user.id}`);
                    return safeReply(interaction, E(`✅ ลบร้าน **${shop.shopName}** ทั้งหมดแล้ว (มี ${shop.groupIds.length} กลุ่มในร้านนี้)`));
                }

                if (!shop.groupIds.includes(groupId.trim()))
                    return safeReply(interaction, E(`❌ ไม่พบกลุ่ม \`${groupId}\` ในร้าน **${shop.shopName}**`));

                // ใช้ findOneAndUpdate + $pull แทน filter-then-save เพื่อกัน race condition
                const updated = await Shop.findOneAndUpdate(
                    { _id: shop._id },
                    { $pull: { groupIds: groupId.trim() } },
                    { returnDocument: 'after' }
                );
                console.log(`[REMOVESHOP] ลบกลุ่ม ${groupId} ออกจากร้าน "${shop.shopName}" โดย ${interaction.user.id}`);
                return safeReply(interaction, E(`✅ ลบกลุ่ม \`${groupId}\` ออกจากร้าน **${shop.shopName}** แล้ว (เหลือ ${updated.groupIds.length} กลุ่ม)`));
            } catch (err) {
                console.error(`[REMOVESHOP] error: ${err.message}`);
                return safeReply(interaction, E('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ'));
            }
        }

        // /renameshop — [แอดมิน] เปลี่ยนชื่อร้านเติม
        if (commandName === 'renameshop') {
            if (!hasPermission(member))
                return safeReply(interaction, E('❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ'));

            try {
                const shopNameInput = interaction.options.getString('shopname').trim();
                const newName       = interaction.options.getString('newname').trim();

                if (!newName)
                    return safeReply(interaction, E('❌ ชื่อใหม่ห้ามเว้นว่าง'));

                const shop = await Shop.findOne({ shopName: { $regex: `^${shopNameInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
                if (!shop)
                    return safeReply(interaction, E(`❌ ไม่พบร้าน **${shopNameInput}**`));

                // กันชื่อใหม่ชนกับร้านอื่นที่มีอยู่แล้ว (ไม่สนตัวพิมพ์ใหญ่เล็ก) ยกเว้นชนกับตัวเอง
                const clash = await Shop.findOne({
                    _id: { $ne: shop._id },
                    shopName: { $regex: `^${newName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
                });
                if (clash)
                    return safeReply(interaction, E(`❌ มีร้านชื่อ **${clash.shopName}** อยู่แล้ว ตั้งชื่อซ้ำไม่ได้`));

                const oldName = shop.shopName;
                // ใช้ findOneAndUpdate แทน mutate-then-save เพื่อความสอดคล้องและกัน race condition
                await Shop.findOneAndUpdate({ _id: shop._id }, { shopName: newName });

                console.log(`[RENAMESHOP] เปลี่ยนชื่อร้าน "${oldName}" → "${newName}" โดย ${interaction.user.id}`);
                return safeReply(interaction, E(`✅ เปลี่ยนชื่อร้าน **${oldName}** → **${newName}** แล้ว (มี ${shop.groupIds.length} กลุ่มในร้านนี้)`));
            } catch (err) {
                console.error(`[RENAMESHOP] error: ${err.message}`);
                return safeReply(interaction, E('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ'));
            }
        }

        // /groupstatus — เช็คสถานะเข้ากลุ่ม + นับวันว่าครบ 15 วัน (เติมได้แล้ว) หรือยัง
        if (commandName === 'groupstatus') {
            try {
                const targetUser = interaction.options.getUser('user') || interaction.user;
                const groupIdOpt = interaction.options.getString('groupid');
                const shopOpt    = interaction.options.getString('shop');

                if (targetUser.id !== interaction.user.id && !hasPermission(member))
                    return safeReply(interaction, E('❌ เฉพาะแอดมินหรือสตาฟเท่านั้นที่ดูของคนอื่นได้'));

                const sync = await RobloxSync.findOne({ discordId: targetUser.id });
                if (!sync)
                    return safeReply(interaction, E(`❌ ${targetUser.id === interaction.user.id ? 'คุณ' : 'สมาชิกคนนี้'}ยังไม่ได้ลงทะเบียน Roblox เลย`));

                const tracker = await GroupTracker.findOne({ discordId: targetUser.id });
                if (!tracker || tracker.groups.length === 0)
                    return safeReply(interaction, E(`❌ ${targetUser.id === interaction.user.id ? 'คุณ' : 'สมาชิกคนนี้'}ยังไม่มีกลุ่มที่ต้อง track เลย (รอแอดมิน /addgroup ก่อน)`));

                let groupsToShow = tracker.groups;
                let shopLabel    = null;

                // ถ้าระบุ shop มา ให้กรองตามรายชื่อกลุ่มในร้านนั้นก่อน (ค้นหาแบบไม่สนตัวพิมพ์ใหญ่เล็ก)
                if (shopOpt) {
                    const shop = await Shop.findOne({ shopName: { $regex: `^${shopOpt.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
                    if (!shop)
                        return safeReply(interaction, E(`❌ ไม่พบร้าน **${shopOpt}**`));
                    if (shop.groupIds.length === 0)
                        return safeReply(interaction, E(`❌ ร้าน **${shop.shopName}** ยังไม่มีกลุ่มอยู่เลย`));

                    groupsToShow = tracker.groups.filter(g => shop.groupIds.includes(g.groupId));
                    shopLabel = shop.shopName;

                    if (groupsToShow.length === 0)
                        return safeReply(interaction, E(`❌ ${targetUser.id === interaction.user.id ? 'คุณ' : 'สมาชิกคนนี้'}ยังไม่ได้ track กลุ่มไหนในร้าน **${shop.shopName}** เลย`));
                }

                // ถ้าระบุ groupid มาด้วย ให้กรองซ้ำอีกชั้นจากผลของ shop (หรือทั้งหมดถ้าไม่ได้ระบุ shop)
                if (groupIdOpt) {
                    groupsToShow = groupsToShow.filter(x => x.groupId === groupIdOpt);
                    if (groupsToShow.length === 0)
                        return safeReply(interaction, E(`❌ ไม่พบกลุ่ม \`${groupIdOpt}\`${shopLabel ? ` ในร้าน **${shopLabel}**` : ' ในรายการติดตาม'}`));
                }

                const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                const displayName  = targetMember ? targetMember.displayName : (sync.lastDisplayName || sync.robloxUsername || targetUser.username);

                const COOLDOWN_DAYS = 15;
                const buildStatus = (g) => {
                    if (g.status !== 'joined' || !g.joinedAt) return { text: '⏳ ยังไม่เข้ากลุ่ม', joined: false };
                    const daysSinceJoin = Math.floor((Date.now() - new Date(g.joinedAt).getTime()) / (1000 * 60 * 60 * 24));
                    if (daysSinceJoin >= COOLDOWN_DAYS) return { text: '✅ เติมได้แล้ว', joined: true };
                    const daysLeft = COOLDOWN_DAYS - daysSinceJoin;
                    return { text: `⏳ รออีก ${daysLeft} วัน (เข้ากลุ่มมาแล้ว ${daysSinceJoin} วัน)`, joined: true };
                };

                // สีโดยรวม: เขียวถ้าทุกกลุ่มเติมได้แล้ว, แดงถ้ามีกลุ่มที่ยังไม่เข้า, เหลืองถ้ากำลังรอ
                const statuses = groupsToShow.map(g => ({ g, ...buildStatus(g) }));
                let color = 0x57F287;
                if (statuses.some(s => !s.joined)) color = 0xED4245;
                else if (statuses.some(s => !s.text.startsWith('✅'))) color = 0xFEE75C;

                const embed = new EmbedBuilder()
                    .setTitle(shopLabel ? `📊 สถานะกลุ่ม Roblox — ร้าน ${shopLabel}` : '📊 สถานะกลุ่ม Roblox')
                    .setDescription(
                        `👤 **ชื่อผู้ใช้:** ${displayName} (${sync.robloxUsername || sync.lastDisplayName})\n` +
                        `🆔 **รหัสผู้ใช้:** \`${sync.robloxId}\``
                    )
                    .addFields(statuses.map(({ g, text }) => ({
                        name: `🏷️ ${g.groupName || `Group ID: ${g.groupId}`}`,
                        value: `📊 ${text}${g.groupName ? `\n🆔 \`${g.groupId}\`` : ''}`,
                        inline: false,
                    })))
                    .setColor(color)
                    .setFooter({ text: shopLabel
                        ? `แสดง ${groupsToShow.length} กลุ่มในร้าน ${shopLabel} • เช็คสถานะทุก 10 นาที`
                        : `ติดตามอยู่ ${tracker.groups.length} กลุ่ม • เช็คสถานะทุก 10 นาที` });

                return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
            } catch (err) {
                console.error(`[GROUPSTATUS] error: ${err.message}`);
                return safeReply(interaction, E('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ'));
            }
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
                    '🎮 Roblox Username\n' +
                    '🏷️ ชื่อเล่น\n\n' +
                    '⚠️ Display Name ใน Roblox ต้องขึ้นต้นด้วย **ORION** นะ\n\n' +
                    '🛠️ หากระบบมีปัญหาติดต่อผู้พัฒนา: <@360498353462575115>'
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
                return safeReply(interaction, E('❌ แค่แอดมินหรือสตาฟเท่านั้นที่เข้าเมนูนี้ได้นะ'));

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
            return safeReply(interaction, {
                content: '⚙️ เลือกได้เลย:', components: [row1, row2], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📅 ดูกิจกรรม / ลงชื่อ ─────────────────────────
        if (customId === 'main_list_btn') {
            const events = await Event.find({
                active: true, channelId: interaction.channelId
            });
            if (!events.length)
                return safeReply(interaction, E('😅 ตอนนี้ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));

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
            return safeReply(interaction, {
                content: '📅 กิจกรรมที่เปิดอยู่ตอนนี้:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📋 ดึงรายชื่อ ──────────────────────────────────
        if (customId === 'main_export_btn') {
            if (!hasPermission(member))
                return safeReply(interaction, E('❌ ไม่มีสิทธิ์ดึงรายชื่อนะ'));

            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length)
                return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมในระบบเลย'));

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
            return safeReply(interaction, {
                content: '🔍 เลือกกิจกรรมที่ต้องการ:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 📖 ประวัติของฉัน ───────────────────────────────
        if (customId === 'main_history_btn') {
            // รองรับทั้ง userId ตรงๆ และรูปแบบเก่า <@userId>
            const history = await History.findOne({
                $or: [
                    { userId: user.id },
                    { userId: `<@${user.id}>` },
                    { userId: `<@!${user.id}>` },
                ]
            });
            if (!history?.records.length)
                return safeReply(interaction, E('📭 ยังไม่มีประวัติการเข้าร่วมเลยนะ ลองมาร่วมกิจกรรมดูสิ!'));

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

            return safeReply(interaction, {
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
                return safeReply(interaction, E('📭 ตอนนี้ยังไม่ได้ลงชื่อกิจกรรมไหนอยู่เลย'));

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
            return safeReply(interaction, {
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
            if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
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
            return safeReply(interaction, {
                content: '✏️ จะแก้ไขกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 🗑️ ลบกิจกรรม ──────────────────────────────────
        if (customId === 'action_delete') {
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return safeReply(interaction, E('😅 ไม่มีกิจกรรมใน channel นี้เลย'));
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
            return safeReply(interaction, {
                content: '⚠️ เลือกกิจกรรมที่จะ **ลบถาวร** ได้เลย:', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── 🔁 เปิด/ปิดกิจกรรม ────────────────────────────
        if (customId === 'action_toggle') {
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
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
            return safeReply(interaction, {
                content: '🔁 สลับสถานะกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── ✅ เช็คชื่อผู้เข้าร่วม ─────────────────────────
        if (customId === 'action_manual_add') {
            if (!hasPermission(interaction.member))
                return safeReply(interaction, E('❌ ไม่มีสิทธิ์เพิ่มรายชื่อนะ'));
            const events = await Event.find({ active: true, channelId: interaction.channelId });
            if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));
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
            return safeReply(interaction, { content: '📝 เลือกกิจกรรมที่จะเพิ่มรายชื่อ Manual:', components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (customId === 'action_remove_member') {
            if (!hasPermission(interaction.member))
                return safeReply(interaction, E('❌ ไม่มีสิทธิ์นะ'));
            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
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
            return safeReply(interaction, { content: '🗑️ เลือกกิจกรรมที่จะลบรายชื่อสมาชิก:', components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (customId === 'action_checkin') {
            if (!hasPermission(interaction.member))
                return safeReply(interaction, E('❌ ไม่มีสิทธิ์เช็คชื่อนะ'));

            const events = await Event.find({ channelId: interaction.channelId });
            if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมในระบบเลย'));
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
            return safeReply(interaction, {
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
            const birthdayRaw    = interaction.fields.getTextInputValue('reg_birthday').trim();
            // validate รูปแบบ วว/ดด
            let birthday = null;
            if (birthdayRaw) {
                const bdMatch = birthdayRaw.match(/^(\d{1,2})[/\-](\d{1,2})$/);
                if (!bdMatch) return interaction.reply({ content: '❌ รูปแบบวันเกิดไม่ถูกต้อง กรุณากรอกเป็น วว/ดด เช่น 25/12', flags: [MessageFlags.Ephemeral] });
                const dd = bdMatch[1].padStart(2, '0');
                const mm = bdMatch[2].padStart(2, '0');
                birthday = `${dd}-${mm}`;
            }

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
                { guildId: interaction.guild.id, discordId: interaction.user.id, robloxId, robloxUsername, lastDisplayName: displayName, ...(birthday !== null && { birthday }) },
                { upsert: true }
            );

            // เพิ่มสมาชิกใหม่เข้า track กลุ่มทั้งหมดที่แอดมินเปิดไว้แล้วโดยอัตโนมัติ
            try {
                const trackedGroups = await TrackedGroups.find({});
                for (const tg of trackedGroups) {
                    await addGroupToUserTracker(interaction.user.id, robloxId, tg.groupId, tg.groupName);
                }
                if (trackedGroups.length > 0)
                    console.log(`[REGISTER] เพิ่ม ${interaction.user.id} เข้า track ${trackedGroups.length} กลุ่มที่มีอยู่แล้ว`);
            } catch (err) {
                console.error(`[REGISTER] error เพิ่ม group tracking: ${err.message}`);
            }

            const finalName  = `${displayName} (${nickname})`;
            const oldName2   = interaction.member.displayName;
            await interaction.member.setNickname(finalName).catch((err) => {
                console.error(`[REGISTER] setNickname ไม่ได้ (${interaction.user.id}): ${err.message}`);
            });
            await interaction.member.roles.add(MEMBER_ROLE_ID).catch(() => {});
            await sendRenameLog(interaction.guild, oldName2, finalName, '📝 ลงทะเบียนสมาชิกใหม่');


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
                return safeReply(interaction, E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ ลองใหม่แบบนี้: `ปปปป-ดด-วว ชช:นน`'));
            if (isNaN(maxSlots) || maxSlots < 0)
                return safeReply(interaction, E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

            const imageUrl = interaction.fields.getTextInputValue('image').trim();
            const channelId = interaction.channelId;
            const eventId = `evt_${Date.now()}`;
            await new Event({
                eventId, channelId, title, desc, imageUrl,
                participants: [], waitingList: [], attendedUserTags: [],
                maxSlots, endTime, endTimeStr: timeRaw, active: true,
            }).save();

            return safeReply(interaction, E(`✅ สร้างกิจกรรม **"${title}"** เรียบร้อยแล้ว!\n📌 ID: \`${eventId}\``));
        }

        // ── เพิ่มรายชื่อ Manual ────────────────────────────
        if (interaction.customId.startsWith('modal_manual_add_')) {
            const eventId = interaction.customId.replace('modal_manual_add_', '');
            const event   = await Event.findOne({ eventId });
            if (!event) return safeReply(interaction, E('❌ หากิจกรรมนี้ไม่เจอแล้ว'));

            const rawInput = interaction.fields.getTextInputValue('manual_names');
            const userIds  = rawInput.split('\n').map(n => n.trim()).filter(n => /^\d{17,20}$/.test(n));
            const invalid  = rawInput.split('\n').map(n => n.trim()).filter(n => n.length > 0 && !/^\d{17,20}$/.test(n));

            if (!userIds.length)
                return safeReply(interaction, E('❌ ไม่เจอ User ID ที่ถูกต้องเลย ต้องเป็นตัวเลข 17-20 หลักนะ'));

            const added   = [];
            const skipped = [];
            const notFound = [];

            for (const uid of userIds) {
                // ตรวจว่า member อยู่ใน guild จริงไหม
                const m = await interaction.guild.members.fetch(uid).catch(() => null);
                if (!m) { notFound.push(uid); continue; }

                // เช็คซ้ำด้วย userId
                const alreadyIn = event.participants.includes(uid) || event.waitingList.some(p => p.userTag === uid);
                if (alreadyIn) { skipped.push(m.displayName); continue; }

                if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
                    event.participants.push(uid);  // เก็บ userId
                    added.push(m.displayName);
                } else {
                    event.waitingList.push({ userTag: uid, wantMain: true });  // เก็บ userId
                    added.push(`${m.displayName} (คิวรอ)`);
                }
            }
            await event.save();

            const addedText    = added.length    ? added.map(n => `• ${n}`).join('\n')    : '_ไม่มี_';
            const skippedText  = skipped.length  ? skipped.map(n => `• ${n}`).join('\n')  : null;
            const notFoundText = notFound.length  ? notFound.map(n => `• ${n}`).join('\n') : null;
            const invalidText  = invalid.length   ? invalid.map(n => `• ${n}`).join('\n')  : null;

            return safeReply(interaction, E(
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
            if (!event) return safeReply(interaction, E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปแล้ว'));

            const newTitle = interaction.fields.getTextInputValue('title').trim();
            const newDesc  = interaction.fields.getTextInputValue('desc').trim();
            const newTimeRaw = interaction.fields.getTextInputValue('time').trim();
            const newSlots = parseInt(interaction.fields.getTextInputValue('slots').trim(), 10);
            const newDate = new Date(newTimeRaw);

            if (isNaN(newDate.getTime()))
                return safeReply(interaction, E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ'));
            if (isNaN(newSlots) || newSlots < 0)
                return safeReply(interaction, E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

            if (newTitle) event.title = newTitle;
            if (newDesc)  event.desc  = newDesc;
            event.endTime = newDate;
            event.endTimeStr = newTimeRaw;
            event.maxSlots = newSlots;
            await event.save();

            return safeReply(interaction, E(`✅ อัปเดตกิจกรรม **"${event.title}"** เรียบร้อยแล้ว!`));
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

        // ── ดูกิจกรรมเพื่อลงชื่อ ──────────────────────────
        if (customId === 'select_view_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            if (!event.active) return safeReply(interaction, E('❌ กิจกรรมนี้ปิดรับแล้วนะ'));

            return safeReply(interaction, {
                embeds: [await buildEventEmbed(event, interaction.guild)],
                components: [buildJoinButtons(eventId)],
                flags: [MessageFlags.Ephemeral],
            });
        }

        // ── เลือกกิจกรรมเพื่อลบรายชื่อ → Dropdown รายคน ──
    if (customId === 'select_remove_member_event') {
        const event = await Event.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const allPeople = [
            ...event.participants.map(t => ({ userTag: t, type: 'main' })),
            ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
        ];
        if (!allPeople.length) return safeReply(interaction, E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));

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
        return safeReply(interaction, {
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
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

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
        return safeReply(interaction, E(
            `✅ ลบ **${removed.length} คน** ออกจากกิจกรรม **"${event.title}"** เรียบร้อย!
` +
            names.map(n => `• ${n}`).join('\n')
        ));
    }

    // ── เลือกกิจกรรมเพื่อเพิ่มรายชื่อ Manual → Modal ──
    if (customId === 'select_manual_add_event') {
        const event = await Event.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

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
            const event = await Event.findOne({ eventId });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            // resolve ชื่อจาก userId ทั้งหมด
            const resolvedMain     = await resolveList(interaction.guild, event.participants);
            const resolvedWait     = await Promise.all(event.waitingList.map(async p => ({
                ...p, display: await resolveDisplayName(interaction.guild, p.userTag)
            })));
            const resolvedAttended = await resolveList(interaction.guild, event.attendedUserTags ?? []);

            const mainList     = resolvedMain.length
                ? resolvedMain.map((u, i) => `${i + 1}. ${u}`).join('\n') : '_ไม่มีรายชื่อ_';
            const waitList     = resolvedWait.length
                ? resolvedWait.map((p, i) => `${i + 1}. ${p.display}  ${p.wantMain ? '(รอคิว)' : '(สำรอง)'}`).join('\n') : '_ไม่มีรายชื่อสำรอง_';
            const attendedList = resolvedAttended.length
                ? resolvedAttended.map((u, i) => `${i + 1}. ${u}`).join('\n') : '_ยังไม่มีการเช็คชื่อ_';

            const embed = new EmbedBuilder()
            .setTitle(`📊 สรุปรายชื่อ: ${event.title}`)
            .setDescription([
                `**🟢 ตัวจริง:**\n${mainList}`,
                `**⏳ สำรอง:**\n${waitList}`,
                `**✅ มาจริง (เช็คแล้ว):**\n${attendedList}`,
            ].join('\n\n'))
            .setColor(0xEB459E);

            return safeReply(interaction, {
                embeds: [embed], flags: [MessageFlags.Ephemeral]
            });
        }

        // ── เลือกกิจกรรมเพื่อแก้ไข → Modal ───────────────
        if (customId === 'select_edit_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

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
            if (!deleted) return safeReply(interaction, E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปก่อนหน้านี้แล้ว'));
            return safeReply(interaction, E(`🗑️ ลบกิจกรรม **"${deleted.title}"** ออกจากระบบเรียบร้อย!`));
        }

        // ── สลับสถานะเปิด/ปิด ──────────────────────────────
        if (customId === 'select_toggle_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            event.active = !event.active;
            await event.save();
            return safeReply(interaction, E(
                event.active
                ? `🟢 เปิดรับลงชื่อแล้ว — **"${event.title}"**`: `🔴 ปิดรับลงชื่อแล้ว — **"${event.title}"**`
            ));
        }

        // ── เลือกกิจกรรมเพื่อเช็คชื่อ → Dropdown รายคน ───
        if (customId === 'select_checkin_event') {
            const event = await Event.findOne({ eventId });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            const allPeople = [
                ...event.participants.map(t => ({ userTag: t, type: 'main' })),
                ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
            ];
            if (!allPeople.length) return safeReply(interaction, E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));
            return safeReply(interaction, await buildCheckinPage(interaction, event, 0));
        }

        // ── เพิ่มเช็คชื่อ ───────────────────────────────────
        if (customId === 'select_checkin_add') {
            const evId = values[0].substring(0, values[0].indexOf('||'));
            const event = await Event.findOne({
                eventId: evId
            });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

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
            return safeReply(interaction, E(
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
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

            const removed = [];
            for (const val of values) {
                const userTag = val.substring(val.indexOf('||') + 2);
                const idx = (event.attendedUserTags ?? []).indexOf(userTag);
                if (idx !== -1) {
                    event.attendedUserTags.splice(idx, 1);
                    removed.push(userTag);
                    // ลบออกจากประวัติด้วย (userTag คือ userId ตรงๆ แล้ว)
                    const uid = /^\d{17,20}$/.test(userTag) ? userTag : extractUserId(userTag);
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
            return safeReply(interaction, E(
                `↩️ ยกเลิกเช็คชื่อ **${removed.length}** คนเรียบร้อย\n${nameList}\n\n` +
                `📊 รวมเช็คแล้ว ${event.attendedUserTags.length} / ${total} คน`
            ));
        }

        // ── ดูลำดับคิวของตัวเอง ────────────────────────────
        if (customId === 'select_myqueue_event') {
            const event = await Event.findOne({
                eventId
            });
            if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
            const userTag = getUserTag(member, user);

            const mainIdx = event.participants.indexOf(userTag);
            if (mainIdx !== -1)
                return safeReply(interaction, E(`✅ คุณอยู่ใน **ตัวจริง** ลำดับที่ **${mainIdx + 1}** — **"${event.title}"**`));

            const waitIdx = event.waitingList.findIndex(p => p.userTag === userTag);
            if (waitIdx !== -1) {
                const p = event.waitingList[waitIdx];
                const pos = event.waitingList.slice(0, waitIdx + 1).filter(w => w.wantMain === p.wantMain).length;
                return safeReply(interaction, E('✅ คุณอยู่ในคิวของกิจกรรมนี้แล้ว'));
            }

            return safeReply(interaction, E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
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
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reg_nickname')
                        .setLabel('ชื่อเล่น')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reg_birthday')
                        .setLabel('วันเกิด (วว/ดด)')
                        .setPlaceholder('เช่น 25/12')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
            );
            return interaction.showModal(modal);
        }

        let action = 'leave';
        if (customId.startsWith('join_')) action = 'join';
        if (customId.startsWith('wait_')) action = 'wait';

        const eventId = customId.replace(`${action}_`, '');

        if (checkCooldown(user.id, eventId))
            return safeReply(interaction, E('⏱️ ใจเย็นๆ นะ รอแป๊บนึงแล้วลองใหม่!'));

        const event = await Event.findOne({
            eventId
        });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        if (!event.active) return safeReply(interaction, E('❌ กิจกรรมนี้ปิดรับแล้วนะ'));

        const userTag = getUserTag(member, user);
        const isJoined = event.participants.includes(userTag) || event.waitingList.some(p => p.userTag === userTag);

        // ── ลงชื่อตัวจริง ──────────────────────────────────
        if (action === 'join') {
            if (isJoined) return safeReply(interaction, E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));

            if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
                event.participants.push(userTag);
                await event.save();
                await safeReply(interaction, E('✅ ลงชื่อ **ตัวจริง** เรียบร้อยแล้ว เจอกันนะ! 🎉'));
            } else {
                event.waitingList.push({
                    userTag, wantMain: true
                });
                await event.save();
                const pos = event.waitingList.filter(w => w.wantMain).length;
                await safeReply(interaction, E(`⏳ โควต้าเต็มแล้ว! คุณอยู่ในคิวสำรองลำดับที่ **${pos}** ถ้ามีคนถอนตัว เดี๋ยวแจ้ง DM ให้เลย 📩`));
            }
        }

        // ── ลงชื่อสำรอง ────────────────────────────────────
        else if (action === 'wait') {
            if (isJoined) return safeReply(interaction, E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));
            event.waitingList.push({
                userTag, wantMain: false
            });
            await event.save();
            await safeReply(interaction, E('💤 บันทึกเป็น **สำรอง** แล้วนะ ถ้าเปลี่ยนใจอยากขึ้นตัวจริงก็ยกเลิกแล้วกดลงชื่อใหม่ได้เลย!'));
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

            if (!removed) return safeReply(interaction, E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
            await event.save();
            await safeReply(interaction, E('👋 ยกเลิกการลงชื่อเรียบร้อย เปลี่ยนใจเมื่อไหร่ก็ลงใหม่ได้นะ~'));
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
            catch { return await safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว')); }
        }

        const pageData = await buildCheckinPage(interaction, event, page);
        try { return await interaction.update(pageData); }
        catch { return await safeReply(interaction, pageData); }
    });

    // ════════════════════════════════════════════════════════
    //  BUTTON: rlp|| (robloxlist pagination)
    // ════════════════════════════════════════════════════════
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('rlp||')) return;

        const parts    = interaction.customId.split('||');
        const cacheKey = parts[1];
        const page     = parseInt(parts[2]);

        // ฟังก์ชัน rebuild pages จาก DB เมื่อ cache หมดอายุ
        async function getRobloxPages(guildObj) {
            const syncs = await RobloxSync.find({});
            const lines = [];
            for (const sync of syncs) {
                const m = await guildObj.members.fetch(sync.discordId).catch(() => null);
                const discordName = m ? m.displayName : `<@${sync.discordId}>`;
                lines.push(`**${discordName}**\n🎮 Roblox Username: \`${sync.robloxUsername || sync.lastDisplayName}\``);
            }
            const PAGE = 10;
            const pages = [];
            for (let i = 0; i < lines.length; i += PAGE)
                pages.push(lines.slice(i, i + PAGE).join('\n\n'));
            return { pages, total: syncs.length };
        }

        let cached = robloxListCache.get(cacheKey);

        // ถ้า cache หมดอายุ ดึงใหม่จาก DB อัตโนมัติ
        if (!cached) {
            const fresh = await getRobloxPages(interaction.guild);
            robloxListCache.set(cacheKey, fresh);
            if (robloxListTimers.has(cacheKey)) clearTimeout(robloxListTimers.get(cacheKey));
            robloxListTimers.set(cacheKey, setTimeout(() => { robloxListCache.delete(cacheKey); robloxListTimers.delete(cacheKey); }, 10 * 60_000));
            cached = fresh;
        }

        const { pages, total } = cached;
        const safePage = Math.min(Math.max(page, 0), pages.length - 1);

        const embed = new EmbedBuilder()
            .setTitle(`📋 รายชื่อ Roblox ทั้งหมด (${total} คน)`)
            .setDescription(pages[safePage])
            .setColor(0x5865F2)
            .setFooter({ text: `หน้า ${safePage + 1}/${pages.length}  •  ทั้งหมด ${total} คน` });

        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rlp||${cacheKey}||${safePage - 1}`).setLabel('◀ ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
            new ButtonBuilder().setCustomId(`rlp||${cacheKey}||${safePage + 1}`).setLabel('▶ ถัดไป').setStyle(ButtonStyle.Secondary).setDisabled(safePage === pages.length - 1),
        )];

        try {
            await interaction.update({ embeds: [embed], components });
        } catch (err) {
            if (err?.code === 40060 || err?.code === 10062) {
                // Interaction หมดอายุหรือ acknowledged ไปแล้ว — ลอง followUp แทน
                await interaction.followUp({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }
    });

    process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

    client.login(BOT_TOKEN);