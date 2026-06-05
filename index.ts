import 'dotenv/config';
import {
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
    ButtonInteraction,
    StringSelectMenuInteraction,
    ModalSubmitInteraction,
    ChatInputCommandInteraction,
    GuildMember,
    Guild,
    MessageCreateOptions,
    InteractionReplyOptions,
    InteractionUpdateOptions,
} from 'discord.js';
import mongoose, { Schema, Document, Model } from 'mongoose';
import express from 'express';

// ════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════
const BOT_TOKEN: string         = process.env.BOT_TOKEN!;
const MONGO_URI: string         = process.env.MONGOTOKEN!;
const MEMBER_ROLE_ID            = '1472776595554042049';
const RENAME_LOG_CHANNEL_ID     = '1507318365864071178';

const ALLOWED_ROLE_IDS: string[] = [
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
app.get('/', (_req, res) => res.send('บอทยังอยู่นะ!'));
app.listen(Number(process.env.PORT) || 3000, () => console.log('🌐 Web server พร้อมแล้ว'));

// ════════════════════════════════════════════════════════
//  PROTECTED CHANNELS
// ════════════════════════════════════════════════════════
const protectedChannels = new Set<string>();

// ════════════════════════════════════════════════════════
//  DISCORD CLIENT
// ════════════════════════════════════════════════════════
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ════════════════════════════════════════════════════════
//  COOLDOWN
// ════════════════════════════════════════════════════════
const cooldownMap = new Map<string, number>();
const robloxListCache = new Map<string, { pages: string[]; total: number }>();

function checkCooldown(userId: string, eventId: string): boolean {
    const key  = `${userId}:${eventId}`;
    const last = cooldownMap.get(key) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return true;
    cooldownMap.set(key, Date.now());
    return false;
}

// ════════════════════════════════════════════════════════
//  MONGODB INTERFACES & SCHEMAS
// ════════════════════════════════════════════════════════
interface IWaitingEntry {
    userTag: string;
    wantMain: boolean;
}

interface IEvent extends Document {
    eventId: string;
    channelId: string;
    title: string;
    desc: string;
    imageUrl: string;
    participants: string[];
    waitingList: IWaitingEntry[];
    attendedUserTags: string[];
    maxSlots: number;
    endTime: Date;
    endTimeStr: string;
    active: boolean;
}

interface IHistory extends Document {
    userId: string;
    userTag: string;
    records: Array<{
        eventId: string;
        eventTitle: string;
        attendedAt: Date;
    }>;
}

interface IRobloxSync extends Document {
    discordId: string;
    robloxId: string;
    robloxUsername: string;
    lastDisplayName: string;
    birthday: string; // รูปแบบ วว/ดด เช่น 25/12
}

const EventModel: Model<IEvent> = mongoose.model<IEvent>('Event', new Schema<IEvent>({
    eventId:          { type: String, unique: true },
    channelId:        String,
    title:            String,
    desc:             String,
    imageUrl:         { type: String, default: '' },
    participants:     [String],
    waitingList:      [Object],
    attendedUserTags: [String],
    maxSlots:         { type: Number, default: 0 },
    endTime:          Date,
    endTimeStr:       String,
    active:           { type: Boolean, default: true },
}));

const HistoryModel: Model<IHistory> = mongoose.model<IHistory>('History', new Schema<IHistory>({
    userId:  { type: String, unique: true },
    userTag: String,
    records: [{
        eventId:    String,
        eventTitle: String,
        attendedAt: { type: Date, default: Date.now },
    }],
}));

const RobloxSyncModel: Model<IRobloxSync> = mongoose.model<IRobloxSync>('RobloxSync', new Schema<IRobloxSync>({
    discordId:       { type: String, unique: true },
    robloxId:        String,
    robloxUsername:  String,
    lastDisplayName: String,
    birthday:        { type: String, default: '' },
}));

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════
type EphemeralOptions = { content: string; flags: [typeof MessageFlags.Ephemeral] };

const E = (msg: string): EphemeralOptions => ({
    content: msg,
    flags: [MessageFlags.Ephemeral],
});

// ── safeReply: ป้องกัน DiscordAPIError[40060] ──────────
type RepliableInteraction =
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
    | ChatInputCommandInteraction;

async function safeReply(
    interaction: RepliableInteraction,
    options: InteractionReplyOptions | EphemeralOptions,
): Promise<void> {
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(options as InteractionReplyOptions);
        } else {
            await interaction.reply(options as InteractionReplyOptions);
        }
    } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        // 40060 = already acknowledged, 10062 = unknown interaction (หมดอายุ)
        if (code !== 40060 && code !== 10062) throw err;
    }
}

function hasPermission(member: GuildMember): boolean {
    return (
        member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id)) ||
        member.permissions.has('Administrator')
    );
}

function getUserTag(_member: GuildMember, user: { id: string }): string {
    return user.id;
}

async function sendRenameLog(
    guildObj: Guild,
    oldName: string,
    newName: string,
    reason = '',
): Promise<void> {
    const logChannel = guildObj.channels.cache.get(RENAME_LOG_CHANNEL_ID);
    if (!logChannel?.isTextBased()) return;
    const embed = new EmbedBuilder()
        .setTitle('✏️ เปลี่ยนชื่อสมาชิก')
        .setDescription(`**${oldName}** ➜ **${newName}**`)
        .addFields({ name: '📌 สาเหตุ', value: reason || 'ไม่ระบุ' })
        .setColor(0xFEE75C)
        .setTimestamp();
    await logChannel.send({ embeds: [embed] } as MessageCreateOptions).catch(() => {});
}

async function resolveDisplayName(guildObj: Guild, userId: string): Promise<string> {
    if (!/^\d{17,20}$/.test(userId)) return userId;
    try {
        const m = await guildObj.members.fetch(userId);
        return m.displayName;
    } catch {
        return `<@${userId}>`;
    }
}

async function resolveList(guildObj: Guild, ids: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const id of ids) {
        results.push(await resolveDisplayName(guildObj, id));
    }
    return results;
}

function stripMention(userTag: string): string {
    return userTag.replace(/\s*\(.*?\)\s*/g, '').trim();
}

function extractUserId(userTag: string): string | null {
    return userTag.match(/<@(\d+)>/)?.[1] ?? null;
}

async function buildEventEmbed(event: IEvent, guildObj?: Guild): Promise<EmbedBuilder> {
    let mainNames: string[] = event.participants;
    if (guildObj) {
        mainNames = await Promise.all(
            event.participants.map(id => resolveDisplayName(guildObj, id)),
        );
    }
    const mainList = mainNames.length
        ? mainNames.map((p, i) => `${i + 1}. ${p}`).join('\n')
        : '_ยังว่างอยู่เลย รีบลงชื่อด่วน!_';

    let waitNames: Array<IWaitingEntry & { display: string }> = event.waitingList.map(p => ({
        ...p,
        display: p.userTag,
    }));
    if (guildObj) {
        waitNames = await Promise.all(
            event.waitingList.map(async p => ({
                ...p,
                display: await resolveDisplayName(guildObj, p.userTag),
            })),
        );
    }
    const waitList = waitNames.length
        ? waitNames
              .map((p, i) => `${i + 1}. ${p.display} ${p.wantMain ? '' : ''}`)
              .join('\n')
        : '_ไม่มีใครรอสำรองอยู่_';

    const slotText =
        event.maxSlots > 0
            ? `${event.participants.length} / ${event.maxSlots} คน`
            : 'ไม่จำกัด';

    return new EmbedBuilder()
        .setTitle(`📌 ${event.title}`)
        .setDescription(
            [
                event.desc,
                '',
                `🕒 **ปิดรับ:** ${event.endTimeStr}`,
                `👥 **โควต้า:** \`${slotText}\``,
                '',
                `**🟢 ตัวจริง:**\n${mainList}`,
                '',
                `**⏳ รายชื่อสำรอง:**\n${waitList}`,
            ].join('\n'),
        )
        .setColor(event.active ? 0x5865f2 : 0x99aab5)
        .setImage(event.imageUrl || null)
        .setFooter({
            text: `ID: ${event.eventId}  •  ${event.active ? '🟢 เปิดรับอยู่' : '🔴 ปิดรับแล้ว'}`,
        });
}

function buildJoinButtons(eventId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`join_${eventId}`)
            .setLabel('🙋 ลงชื่อตัวจริง')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`wait_${eventId}`)
            .setLabel('⏳ ลงชื่อสำรอง')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`leave_${eventId}`)
            .setLabel('❌ ยกเลิก')
            .setStyle(ButtonStyle.Danger),
    );
}

async function recordHistory(
    userId: string,
    userTag: string,
    eventId: string,
    eventTitle: string,
): Promise<void> {
    await HistoryModel.findOneAndUpdate(
        { userId },
        { $set: { userTag }, $push: { records: { eventId, eventTitle } } },
        { upsert: true },
    );
}

async function buildCheckinPage(
    interaction: RepliableInteraction,
    event: IEvent,
    page = 0,
): Promise<InteractionReplyOptions> {
    const PAGE_SIZE = 24;
    const allPeople: Array<{ userTag: string; type: string }> = [
        ...event.participants.map(t => ({ userTag: t, type: 'main' })),
        ...event.waitingList.map(p => ({
            userTag: p.userTag,
            type: p.wantMain ? 'wait_main' : 'wait_reserve',
        })),
    ];
    const attended    = event.attendedUserTags ?? [];
    const typeLabel: Record<string, string> = {
        main:         '🟢 ตัวจริง',
        wait_main:    '⏳ รอคิว',
        wait_reserve: '💤 สำรอง',
    };
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

    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_checkin_add')
                .setPlaceholder(`☑️ ติ๊กคนที่มาจริง (หน้า ${page + 1}/${totalPages})...`)
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options),
        ) as unknown as ActionRowBuilder<ButtonBuilder>,
    );

    if (checkedOptions.length) {
        components.push(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_checkin_remove')
                    .setPlaceholder(`❌ ติ๊กออกคนที่เช็คผิด (หน้า ${page + 1}/${totalPages})...`)
                    .setMinValues(1)
                    .setMaxValues(checkedOptions.length)
                    .addOptions(checkedOptions),
            ) as unknown as ActionRowBuilder<ButtonBuilder>,
        );
    }

    if (totalPages > 1) {
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
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
            ),
        );
    }

    return {
        content:    `☑️ **เช็คชื่อ: ${event.title}** — หน้า ${page + 1}/${totalPages}\nเช็คไปแล้ว ${attended.length} / ${allPeople.length} คน`,
        components: components as ActionRowBuilder<ButtonBuilder>[],
        flags:      [MessageFlags.Ephemeral],
    };
}

// ════════════════════════════════════════════════════════
//  READY
// ════════════════════════════════════════════════════════
client.once('clientReady', async () => {
    console.log(`🤖 บอทออนไลน์แล้ว: ${client.user!.tag}`);
    try {
        if (!MONGO_URI) throw new Error('ไม่เจอตัวแปร MONGOTOKEN');
        await mongoose.connect(MONGO_URI);
        console.log('🍃 ต่อ MongoDB สำเร็จ!');
    } catch (err) {
        console.error('❌ ต่อ MongoDB ไม่ได้:', (err as Error).message);
    }

    // ── Roblox Sync — เช็ค Display Name ทุก 5 นาที ────────
    setInterval(async () => {
        try {
            const syncs = await RobloxSyncModel.find({});
            for (const sync of syncs) {
                try {
                    const res  = await fetch(`https://users.roblox.com/v1/users/${sync.robloxId}`);
                    const data = await res.json() as { displayName?: string };
                    if (!data?.displayName) continue;
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

                    const oldNickname = member.displayName;
                    await member.setNickname(finalName).catch(() => {});
                    sync.lastDisplayName = data.displayName;
                    await sync.save();
                    console.log(`🔄 เปลี่ยนชื่อ ${sync.discordId} → ${finalName}`);
                    await sendRenameLog(guild, oldNickname, finalName, '🔄 Roblox Display Name เปลี่ยน (อัตโนมัติ)');
                } catch { /* ข้ามถ้า fetch ล้มเหลว */ }

                await new Promise(r => setTimeout(r, 500));
            }
        } catch { /* ข้ามถ้า DB ล้มเหลว */ }
    }, 5 * 60_000);

    // ── ปิดกิจกรรมที่หมดเวลาทุก 1 นาที ──────────────────
    setInterval(async () => {
        const expired = await EventModel.find({ active: true, endTime: { $lte: new Date() } });
        for (const ev of expired) {
            ev.active = false;
            await ev.save();
            console.log(`⏰ ปิดกิจกรรมอัตโนมัติ: ${ev.title}`);
        }
    }, 60_000);
});

// ── Register Slash Commands ─────────────────────────────
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
        .addStringOption(o =>
            o.setName('robloxid').setDescription('Roblox Username ของผู้เล่น').setRequired(true),
        )
        .addUserOption(o =>
            o.setName('user').setDescription('สมาชิกที่จะ register (ไม่ใส่ = ตัวเอง)').setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName('unregister')
        .setDescription('ยกเลิก Roblox Sync')
        .addUserOption(o =>
            o.setName('user').setDescription('สมาชิกที่จะยกเลิก (ไม่ใส่ = ตัวเอง)').setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName('setup-register')
        .setDescription('สร้างแผงลงทะเบียนสมาชิกใน channel นี้'),
    new SlashCommandBuilder()
        .setName('staff-remove')
        .setDescription('ลบสมาชิกออกจากตำแหน่ง')
        .addStringOption(o => o.setName('position').setDescription('ชื่อตำแหน่ง').setRequired(true))
        .addStringOption(o =>
            o.setName('member_name').setDescription('ชื่อสมาชิกที่จะลบ').setRequired(true),
        ),
    new SlashCommandBuilder()
        .setName('robloxlist')
        .setDescription('ดึงรายชื่อ Roblox ของสมาชิกทุกคนที่ลงทะเบียนแล้ว'),
    new SlashCommandBuilder()
        .setName('robloxinfo')
        .setDescription('ดูข้อมูล Roblox ของสมาชิกคนที่ระบุ')
        .addUserOption(o =>
            o.setName('user').setDescription('สมาชิกที่ต้องการดู').setRequired(true),
        ),
].map(c => c.toJSON());

client.once('clientReady', async () => {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        const guilds = client.guilds.cache.map(g => g.id);
        for (const guildId of guilds) {
            await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
                body: commands,
            });
        }
        console.log('✅ Register Slash Commands สำเร็จ!');
    } catch (err) {
        console.error('❌ Register Slash Commands ไม่ได้:', (err as Error).message);
    }
});

// ── messageCreate (ลบข้อความใน channel ที่ล็อค) ───────
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (protectedChannels.has(message.channel.id)) {
        if (!hasPermission(message.member!)) {
            await message.delete().catch(() => {});
        }
    }
});

// ════════════════════════════════════════════════════════
//  SLASH COMMANDS
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, channel, guild } = interaction;
    const guildMember = member as GuildMember;

    // /setup
    if (commandName === 'setup') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

        const embed = new EmbedBuilder()
            .setTitle('📅 ระบบจัดการกิจกรรม')
            .setDescription('อยากจัดการหรืออยากลงชื่อเข้าร่วมก็กดได้เลย 👇')
            .setFooter({ text: `📅 อัปเดตล่าสุด: ${new Date().toLocaleDateString('th-TH')}` })
            .setColor(0x5865f2);

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('main_list_btn').setLabel('📅 ดูกิจกรรม / ลงชื่อ').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('main_history_btn').setLabel('📖 ประวัติของฉัน').setStyle(ButtonStyle.Secondary),
        );
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('main_manage_btn').setLabel('⚙️ จัดการกิจกรรม').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('main_export_btn').setLabel('📋 ดึงรายชื่อ').setStyle(ButtonStyle.Secondary),
        );

        await channel!.send({ embeds: [embed], components: [row1, row2] } as MessageCreateOptions);
        protectedChannels.add(channel!.id);
        return interaction.reply({ content: '✅ สร้างแผงกิจกรรมแล้ว!', flags: [MessageFlags.Ephemeral] });
    }

    // /lock
    if (commandName === 'lock') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
        protectedChannels.add(channel!.id);
        return interaction.reply({ content: '🔒 ล็อค channel นี้แล้ว! ข้อความจากสมาชิกจะถูกลบอัตโนมัติ', flags: [MessageFlags.Ephemeral] });
    }

    // /unlock
    if (commandName === 'unlock') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
        protectedChannels.delete(channel!.id);
        return interaction.reply({ content: '🔓 ปลดล็อค channel นี้แล้ว! สมาชิกพิมพ์ได้ตามปกติ', flags: [MessageFlags.Ephemeral] });
    }

    // /register
    if (commandName === 'register') {
        const targetUser     = interaction.options.getUser('user');
        const robloxUsername = interaction.options.getString('robloxid')!;
        let   targetMember   = targetUser
            ? await guild!.members.fetch(targetUser.id).catch(() => null)
            : guildMember;

        if (targetUser && !hasPermission(guildMember))
            return interaction.reply({ content: '❌ ต้องเป็นแอดมินหรือสตาฟถึงจะ register ให้คนอื่นได้นะ', flags: [MessageFlags.Ephemeral] });
        if (!targetMember)
            return interaction.reply({ content: '❌ หาสมาชิกคนนั้นไม่เจอเลย', flags: [MessageFlags.Ephemeral] });
        if (!robloxUsername)
            return interaction.reply({ content: '❌ กรุณาใส่ Roblox Username นะ', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let robloxId: string;
        let displayName: string;
        try {
            const res  = await fetch('https://users.roblox.com/v1/usernames/users', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true }),
            });
            const data = await res.json() as { data?: Array<{ id: number; displayName: string }> };
            if (!data?.data?.length)
                return interaction.editReply(`❌ ไม่เจอ Username **${robloxUsername}** ใน Roblox เลย ลองเช็คใหม่นะ`);
            robloxId    = String(data.data[0].id);
            displayName = data.data[0].displayName;
            if (!displayName.toUpperCase().startsWith('ORION'))
                return interaction.editReply(`❌ Display Name **${displayName}** ไม่ขึ้นต้นด้วย ORION นะ ลองเปลี่ยนชื่อในเกมก่อนแล้วค่อย register ใหม่`);
        } catch {
            return interaction.editReply('❌ เรียก Roblox API ไม่ได้ตอนนี้ ลองใหม่อีกทีนะ');
        }

        const existingByDiscord = await RobloxSyncModel.findOne({ discordId: targetMember.id });
        const existingByRoblox  = await RobloxSyncModel.findOne({ robloxId, discordId: { $ne: targetMember.id } });

        if (existingByDiscord) {
            const isSelf = targetMember.id === interaction.user.id;
            return interaction.editReply(
                `⚠️ ${isSelf ? 'คุณ' : `**${targetMember.displayName}**`} ลงทะเบียนไปแล้วนะ (Roblox: \`${existingByDiscord.robloxUsername || existingByDiscord.lastDisplayName}\`)\n` +
                `ถ้าอยากอัปเดตข้อมูลใหม่ ให้ใช้ \`/unregister\` ก่อนแล้วค่อย register ใหม่`,
            );
        }
        if (existingByRoblox) {
            const otherMember = await guild!.members.fetch(existingByRoblox.discordId).catch(() => null);
            return interaction.editReply(
                `⚠️ Roblox Username **${robloxUsername}** ถูก register โดย ${otherMember ? `<@${otherMember.id}>` : 'สมาชิกคนอื่น'} ไปแล้วนะ`,
            );
        }

        await RobloxSyncModel.findOneAndUpdate(
            { discordId: targetMember.id },
            { discordId: targetMember.id, robloxId, robloxUsername, lastDisplayName: displayName },
            { upsert: true },
        );

        const currentName   = targetMember.displayName;
        const bracketMatch  = currentName.match(/\((.+)\)$/);
        const bracketSuffix = bracketMatch ? bracketMatch[1] : currentName;
        const finalName     = `${displayName} (${bracketSuffix})`;
        await targetMember.setNickname(finalName).catch(() => {});

        return interaction.editReply(
            `✅ ลงทะเบียน **${targetMember.displayName}** กับ Username **${robloxUsername}** เรียบร้อย! เปลี่ยนชื่อเป็น **${finalName}** แล้ว บอทจะเช็คชื่อทุก 5 นาทีนะ`,
        );
    }

    // /robloxlist
    if (commandName === 'robloxlist') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const syncs = await RobloxSyncModel.find({});
        if (!syncs.length) return interaction.editReply('😅 ยังไม่มีสมาชิกลงทะเบียนเลย');

        const lines: string[] = [];
        for (const sync of syncs) {
            const m = await guild!.members.fetch(sync.discordId).catch(() => null);
            const discordName = m ? m.displayName : `<@${sync.discordId}>`;
            lines.push(`**${discordName}**\n🎮 Roblox Username: \`${sync.robloxUsername || sync.lastDisplayName}\``);
        }

        const PAGE   = 10;
        const pages: string[] = [];
        for (let i = 0; i < lines.length; i += PAGE)
            pages.push(lines.slice(i, i + PAGE).join('\n\n'));

        const embed = new EmbedBuilder()
            .setTitle(`📋 รายชื่อ Roblox ทั้งหมด (${syncs.length} คน)`)
            .setDescription(pages[0])
            .setColor(0x5865f2)
            .setFooter({ text: `หน้า 1/${pages.length}  •  ทั้งหมด ${syncs.length} คน` });

        const cacheKey = `${interaction.user.id}_${Date.now()}`;
        robloxListCache.set(cacheKey, { pages, total: syncs.length });
        setTimeout(() => robloxListCache.delete(cacheKey), 10 * 60_000);

        const components: ActionRowBuilder<ButtonBuilder>[] = [];
        if (pages.length > 1) {
            components.push(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`rlp||${cacheKey}||0`)
                        .setLabel('◀ ก่อนหน้า')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`rlp||${cacheKey}||1`)
                        .setLabel('▶ ถัดไป')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(pages.length <= 1),
                ),
            );
        }
        return interaction.editReply({ embeds: [embed], components });
    }

    // /robloxinfo
    if (commandName === 'robloxinfo') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

        const targetUser = interaction.options.getUser('user')!;
        const sync       = await RobloxSyncModel.findOne({ discordId: targetUser.id });

        if (!sync)
            return interaction.reply({ content: `😕 **${targetUser.username}** ยังไม่ได้ลงทะเบียนเลย`, flags: [MessageFlags.Ephemeral] });

        let currentDisplayName = sync.lastDisplayName;
        const profileUrl = `https://www.roblox.com/users/${sync.robloxId}/profile`;
        try {
            const res  = await fetch(`https://users.roblox.com/v1/users/${sync.robloxId}`);
            const data = await res.json() as { displayName?: string };
            if (data?.displayName) currentDisplayName = data.displayName;
        } catch { /* ใช้ค่าเดิมถ้า fetch ไม่ได้ */ }

        const targetMember = await guild!.members.fetch(targetUser.id).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle(`🎮 ข้อมูล Roblox ของ ${targetMember?.displayName ?? targetUser.username}`)
            .setDescription(
                `👤 **Discord:** <@${targetUser.id}>\n` +
                `🎮 **Roblox ID:** \`${sync.robloxId}\`\n` +
                `✨ **Display Name ปัจจุบัน:** ${currentDisplayName}\n` +
                `🔗 **Profile:** [คลิกดูโปรไฟล์](${profileUrl})`,
            )
            .setColor(0xfee75c)
            .setFooter({ text: 'ลงทะเบียนแล้ว • sync ทุก 5 นาที' });

        return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    // /setup-register
    if (commandName === 'setup-register') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });

        const embed = new EmbedBuilder()
            .setTitle('📋 ลงทะเบียนสมาชิก ORION')
            .setDescription(
                'กดปุ่มด้านล่างเพื่อลงทะเบียนเข้าร่วมคลับ\n\n' +
                '**สิ่งที่ต้องเตรียม:**\n' +
                '🎮 Roblox Username ของคุณ\n' +
                '🏷️ ชื่อเล่นที่อยากใช้\n\n' +
                '⚠️ Display Name ใน Roblox ต้องขึ้นต้นด้วย **ORION** นะ',
            )
            .setImage('https://img1.pic.in.th/images/1000040601.jpg')
            .setColor(0x5865f2)
            .setFooter({ text: `📅 อัปเดตล่าสุด: ${new Date().toLocaleDateString('th-TH')}` });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('register_btn')
                .setLabel('📝 ลงทะเบียน')
                .setStyle(ButtonStyle.Success),
        );

        await channel!.send({ embeds: [embed], components: [row] } as MessageCreateOptions);
        return interaction.reply({ content: '✅ สร้างแผงลงทะเบียนเรียบร้อย!', flags: [MessageFlags.Ephemeral] });
    }

    // /unregister
    if (commandName === 'unregister') {
        if (!hasPermission(guildMember))
            return interaction.reply({ content: '❌ เฉพาะแอดมินหรือสตาฟเท่านั้นนะ', flags: [MessageFlags.Ephemeral] });
        const targetUser   = interaction.options.getUser('user');
        const targetId     = targetUser ? targetUser.id : guildMember.id;
        await RobloxSyncModel.findOneAndDelete({ discordId: targetId });
        const targetMember = await guild!.members.fetch(targetId).catch(() => null);
        if (targetMember) {
            await targetMember.roles.remove(MEMBER_ROLE_ID).catch(() => {});
        }
        return interaction.reply({ content: `✅ ยกเลิก Roblox Sync และถอดยศ MEMBER ของ <@${targetId}> เรียบร้อย!`, flags: [MessageFlags.Ephemeral] });
    }
});

// ════════════════════════════════════════════════════════
//  BUTTON: main_*
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('main_')) return;
    const { customId, member, user } = interaction;
    const guildMember = member as GuildMember;

    if (customId === 'main_manage_btn') {
        if (!hasPermission(guildMember))
            return safeReply(interaction, E('❌ แค่แอดมินหรือสตาฟเท่านั้นที่เข้าเมนูนี้ได้นะ'));

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('action_add').setLabel('➕ เพิ่มกิจกรรม').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('action_edit').setLabel('✏️ แก้ไขกิจกรรม').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('action_delete').setLabel('🗑️ ลบกิจกรรม').setStyle(ButtonStyle.Danger),
        );
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('action_toggle').setLabel('🔁 เปิด / ปิดกิจกรรม').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('action_checkin').setLabel('✅ เช็คชื่อผู้เข้าร่วม').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('action_manual_add').setLabel('📝 เพิ่มรายชื่อ Manual').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('action_remove_member').setLabel('🗑️ ลบรายชื่อสมาชิก').setStyle(ButtonStyle.Danger),
        );
        return safeReply(interaction, { content: '⚙️ เลือกได้เลย:', components: [row1, row2], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'main_list_btn') {
        const events = await EventModel.find({ active: true, channelId: interaction.channelId });
        if (!events.length)
            return safeReply(interaction, E('😅 ตอนนี้ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_view_event')
                .setPlaceholder('📌 เลือกกิจกรรมที่อยากเข้าร่วม...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: `โควต้า: ${ev.maxSlots > 0 ? `${ev.participants.length}/${ev.maxSlots}` : 'ไม่จำกัด'}`,
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '📅 กิจกรรมที่เปิดอยู่ตอนนี้:', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'main_export_btn') {
        if (!hasPermission(guildMember))
            return safeReply(interaction, E('❌ ไม่มีสิทธิ์ดึงรายชื่อนะ'));

        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length)
            return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมในระบบเลย'));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_export_event')
                .setPlaceholder('📋 เลือกกิจกรรมที่อยากดูรายชื่อ...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: `ตัวจริง: ${ev.participants.length}  •  สำรอง: ${ev.waitingList.length}`,
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '🔍 เลือกกิจกรรมที่ต้องการ:', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'main_history_btn') {
        const history = await HistoryModel.findOne({ userId: user.id });
        if (!history?.records.length)
            return safeReply(interaction, E('📭 ยังไม่มีประวัติการเข้าร่วมเลยนะ ลองมาร่วมกิจกรรมดูสิ!'));

        const lines = history.records
            .slice(-20)
            .reverse()
            .map((r, i) => `${i + 1}. **${r.eventTitle}** — ${new Date(r.attendedAt).toLocaleDateString('th-TH')}`);

        const embed = new EmbedBuilder()
            .setTitle(`📖 ประวัติของ ${guildMember.displayName}`)
            .setDescription(lines.join('\n'))
            .setColor(0xfee75c)
            .setFooter({ text: `เข้าร่วมมาแล้วทั้งหมด ${history.records.length} ครั้ง` });

        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'main_myqueue_btn') {
        const userTag = getUserTag(guildMember, user);
        const events  = await EventModel.find({
            active: true,
            channelId: interaction.channelId,
            $or: [{ participants: userTag }, { 'waitingList.userTag': userTag }],
        });

        if (!events.length)
            return safeReply(interaction, E('📭 ตอนนี้ยังไม่ได้ลงชื่อกิจกรรมไหนอยู่เลย'));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_myqueue_event')
                .setPlaceholder('🔢 เลือกกิจกรรมที่อยากดูคิว...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: ev.participants.includes(userTag) ? '✅ ตัวจริง' : '⏳ อยู่ในคิวสำรอง',
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '🔢 กิจกรรมที่คุณลงชื่ออยู่ตอนนี้:', components: [row], flags: [MessageFlags.Ephemeral] });
    }
});

// ════════════════════════════════════════════════════════
//  BUTTON: action_*
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('action_')) return;
    const { customId } = interaction;

    if (customId === 'action_add') {
        const modal = new ModalBuilder().setCustomId('modal_create').setTitle('✨ สร้างกิจกรรมใหม่');
        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('title').setLabel('ชื่อกิจกรรม').setStyle(TextInputStyle.Short).setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('desc').setLabel('รายละเอียด').setStyle(TextInputStyle.Paragraph).setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('time').setLabel('วันเวลาปิดรับ  (ปปปป-ดด-วว ชช:นน)').setPlaceholder('เช่น 2026-06-01 18:00').setStyle(TextInputStyle.Short).setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('slots').setLabel('โควต้า (0 = ไม่จำกัด)').setPlaceholder('เช่น 20').setStyle(TextInputStyle.Short).setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('image').setLabel('URL รูปภาพ (ไม่บังคับ)').setPlaceholder('เช่น https://i.imgur.com/abc.png').setStyle(TextInputStyle.Short).setRequired(false),
            ),
        );
        return interaction.showModal(modal);
    }

    if (customId === 'action_edit') {
        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_edit_event')
                .setPlaceholder('✏️ เลือกกิจกรรมที่อยากแก้ไข...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่' : '🔴 ปิดแล้ว',
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '✏️ จะแก้ไขกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'action_delete') {
        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ไม่มีกิจกรรมใน channel นี้เลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_delete_event')
                .setPlaceholder('🗑️ เลือกกิจกรรมที่อยากลบออก...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่' : '🔴 ปิดแล้ว',
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '⚠️ เลือกกิจกรรมที่จะ **ลบถาวร** ได้เลย:', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'action_toggle') {
        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_toggle_event')
                .setPlaceholder('🔁 เลือกกิจกรรมที่จะสลับสถานะ...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: ev.active ? '🟢 เปิดอยู่ → กดเพื่อปิด' : '🔴 ปิดอยู่ → กดเพื่อเปิด',
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '🔁 สลับสถานะกิจกรรมไหนดี?', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'action_manual_add') {
        if (!hasPermission(interaction.member as GuildMember))
            return safeReply(interaction, E('❌ ไม่มีสิทธิ์เพิ่มรายชื่อนะ'));
        const events = await EventModel.find({ active: true, channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมเปิดอยู่ใน channel นี้เลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
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
        if (!hasPermission(interaction.member as GuildMember))
            return safeReply(interaction, E('❌ ไม่มีสิทธิ์นะ'));
        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมใน channel นี้เลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_remove_member_event')
                .setPlaceholder('🗑️ เลือกกิจกรรมที่จะลบรายชื่อ...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: `ตัวจริง: ${ev.participants.length} | สำรอง: ${ev.waitingList.length}`,
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '🗑️ เลือกกิจกรรมที่จะลบรายชื่อสมาชิก:', components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'action_checkin') {
        if (!hasPermission(interaction.member as GuildMember))
            return safeReply(interaction, E('❌ ไม่มีสิทธิ์เช็คชื่อนะ'));

        const events = await EventModel.find({ channelId: interaction.channelId });
        if (!events.length) return safeReply(interaction, E('😅 ยังไม่มีกิจกรรมในระบบเลย'));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_checkin_event')
                .setPlaceholder('✅ เลือกกิจกรรมที่จะเช็คชื่อ...')
                .addOptions(events.map(ev => ({
                    label:       ev.title.substring(0, 25),
                    description: `เช็คแล้ว ${(ev.attendedUserTags ?? []).length} / ${ev.participants.length + ev.waitingList.length} คน`,
                    value:       ev.eventId,
                }))),
        );
        return safeReply(interaction, { content: '📋 เลือกกิจกรรมที่จะเช็คชื่อ:', components: [row], flags: [MessageFlags.Ephemeral] });
    }
});

// ════════════════════════════════════════════════════════
//  MODAL SUBMIT
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (interaction.type !== InteractionType.ModalSubmit) return;
    const modal = interaction as ModalSubmitInteraction;

    // ── ลงทะเบียนสมาชิก ───────────────────────────────
    if (modal.customId === 'modal_register') {
        const robloxUsername = modal.fields.getTextInputValue('reg_roblox_username').trim();
        const nickname       = modal.fields.getTextInputValue('reg_nickname').trim();
        const birthday       = modal.fields.getTextInputValue('reg_birthday').trim();

        // validate วันเกิด วว/ดด
        if (!/^(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])$/.test(birthday))
            return safeReply(modal, E('❌ รูปแบบวันเกิดไม่ถูกต้องนะ ต้องเป็น **วว/ดด** เช่น 25/12'));

        await modal.deferReply({ flags: [MessageFlags.Ephemeral] });

        let robloxId: string;
        let displayName: string;
        try {
            const res  = await fetch('https://users.roblox.com/v1/usernames/users', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true }),
            });
            const data = await res.json() as { data?: Array<{ id: number; displayName: string }> };
            if (!data?.data?.length)
                return modal.editReply(`❌ ไม่เจอ Username **${robloxUsername}** ใน Roblox เลย ลองเช็คใหม่นะ`);
            robloxId    = String(data.data[0].id);
            displayName = data.data[0].displayName;
        } catch {
            return modal.editReply('❌ เรียก Roblox API ไม่ได้ตอนนี้ ลองใหม่อีกทีนะ');
        }

        if (!displayName.toUpperCase().startsWith('ORION'))
            return modal.editReply(`❌ Display Name **${displayName}** ไม่ขึ้นต้นด้วย **ORION** นะ กรุณาเปลี่ยนชื่อใน Roblox ก่อนแล้วค่อยลงทะเบียนใหม่`);

        const existingByDiscord = await RobloxSyncModel.findOne({ discordId: modal.user.id });
        const existingByRoblox  = await RobloxSyncModel.findOne({ robloxId, discordId: { $ne: modal.user.id } });

        if (existingByDiscord)
            return modal.editReply(
                `⚠️ คุณลงทะเบียนไปแล้วนะ (Roblox: \`${existingByDiscord.robloxUsername || existingByDiscord.lastDisplayName}\`)\n` +
                `ถ้าอยากเปลี่ยนข้อมูล ติดต่อแอดมินเพื่อ unregister ก่อนนะ`,
            );
        if (existingByRoblox) {
            const otherMember = await modal.guild!.members.fetch(existingByRoblox.discordId).catch(() => null);
            return modal.editReply(
                `⚠️ Roblox Username **${robloxUsername}** ถูก register โดย ${otherMember ? `<@${otherMember.id}>` : 'สมาชิกคนอื่น'} ไปแล้วนะ`,
            );
        }

        await RobloxSyncModel.findOneAndUpdate(
            { discordId: modal.user.id },
            { discordId: modal.user.id, robloxId, robloxUsername, lastDisplayName: displayName, birthday },
            { upsert: true },
        );

        const finalName  = `${displayName} (${nickname})`;
        const oldName    = (modal.member as GuildMember).displayName;
        await (modal.member as GuildMember).setNickname(finalName).catch(() => {});
        await (modal.member as GuildMember).roles.add(MEMBER_ROLE_ID).catch(() => {});
        await sendRenameLog(modal.guild!, oldName, finalName, '📝 ลงทะเบียนสมาชิกใหม่');

        return modal.editReply(
            `✅ ลงทะเบียนเรียบร้อยแล้ว!\n🎮 Roblox: **${robloxUsername}**\n✨ ชื่อใหม่: **${finalName}**\n🎂 วันเกิด: **${birthday}**\n🏅 ได้รับยศ MEMBER แล้ว!\nบอทจะเช็คชื่อทุก 5 นาทีนะ`,
        );
    }

    // ── สร้างกิจกรรมใหม่ ──────────────────────────────
    if (modal.customId === 'modal_create') {
        const title    = modal.fields.getTextInputValue('title');
        const desc     = modal.fields.getTextInputValue('desc');
        const timeRaw  = modal.fields.getTextInputValue('time').trim();
        const slotsRaw = modal.fields.getTextInputValue('slots').trim();

        const endTime  = new Date(timeRaw);
        const maxSlots = parseInt(slotsRaw, 10);

        if (isNaN(endTime.getTime()))
            return safeReply(modal, E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ ลองใหม่แบบนี้: `ปปปป-ดด-วว ชช:นน`'));
        if (isNaN(maxSlots) || maxSlots < 0)
            return safeReply(modal, E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

        const imageUrl  = modal.fields.getTextInputValue('image').trim();
        const channelId = modal.channelId!;
        const eventId   = `evt_${Date.now()}`;
        await new EventModel({
            eventId, channelId, title, desc, imageUrl,
            participants: [], waitingList: [], attendedUserTags: [],
            maxSlots, endTime, endTimeStr: timeRaw, active: true,
        }).save();

        return safeReply(modal, E(`✅ สร้างกิจกรรม **"${title}"** เรียบร้อยแล้ว!\n📌 ID: \`${eventId}\``));
    }

    // ── เพิ่มรายชื่อ Manual ────────────────────────────
    if (modal.customId.startsWith('modal_manual_add_')) {
        const eventId = modal.customId.replace('modal_manual_add_', '');
        const event   = await EventModel.findOne({ eventId });
        if (!event) return safeReply(modal, E('❌ หากิจกรรมนี้ไม่เจอแล้ว'));

        const rawInput = modal.fields.getTextInputValue('manual_names');
        const userIds  = rawInput.split('\n').map(n => n.trim()).filter(n => /^\d{17,20}$/.test(n));
        const invalid  = rawInput.split('\n').map(n => n.trim()).filter(n => n.length > 0 && !/^\d{17,20}$/.test(n));

        if (!userIds.length)
            return safeReply(modal, E('❌ ไม่เจอ User ID ที่ถูกต้องเลย ต้องเป็นตัวเลข 17-20 หลักนะ'));

        const added:    string[] = [];
        const skipped:  string[] = [];
        const notFound: string[] = [];

        for (const uid of userIds) {
            const m = await modal.guild!.members.fetch(uid).catch(() => null);
            if (!m) { notFound.push(uid); continue; }

            const alreadyIn =
                event.participants.includes(uid) ||
                event.waitingList.some(p => p.userTag === uid);
            if (alreadyIn) { skipped.push(m.displayName); continue; }

            if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
                event.participants.push(uid);
                added.push(m.displayName);
            } else {
                event.waitingList.push({ userTag: uid, wantMain: true });
                added.push(`${m.displayName} (คิวรอ)`);
            }
        }
        await event.save();

        const addedText    = added.length    ? added.map(n => `• ${n}`).join('\n')    : '_ไม่มี_';
        const skippedText  = skipped.length  ? skipped.map(n => `• ${n}`).join('\n')  : null;
        const notFoundText = notFound.length ? notFound.map(n => `• ${n}`).join('\n') : null;
        const invalidText  = invalid.length  ? invalid.map(n => `• ${n}`).join('\n')  : null;

        return safeReply(modal, E(
            `📝 เพิ่มรายชื่อ Manual เรียบร้อย!\n\n` +
            `✅ **เพิ่มแล้ว ${added.length} คน:**\n${addedText}\n` +
            (skippedText  ? `\n⚠️ **ซ้ำ ข้ามไป ${skipped.length} คน:**\n${skippedText}\n`           : '') +
            (notFoundText ? `\n❓ **หาไม่เจอในเซิร์ฟเวอร์ ${notFound.length} ID:**\n${notFoundText}\n` : '') +
            (invalidText  ? `\n❌ **รูปแบบไม่ถูกต้อง ${invalid.length} รายการ:**\n${invalidText}`      : ''),
        ));
    }

    // ── แก้ไขกิจกรรม ──────────────────────────────────
    if (modal.customId.startsWith('modal_edit_')) {
        const eventId = modal.customId.replace('modal_edit_', '');
        const event   = await EventModel.findOne({ eventId });
        if (!event) return safeReply(modal, E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปแล้ว'));

        const newTitle   = modal.fields.getTextInputValue('title').trim();
        const newDesc    = modal.fields.getTextInputValue('desc').trim();
        const newTimeRaw = modal.fields.getTextInputValue('time').trim();
        const newSlots   = parseInt(modal.fields.getTextInputValue('slots').trim(), 10);
        const newDate    = new Date(newTimeRaw);

        if (isNaN(newDate.getTime()))
            return safeReply(modal, E('❌ รูปแบบวันเวลาไม่ถูกต้องนะ'));
        if (isNaN(newSlots) || newSlots < 0)
            return safeReply(modal, E('❌ โควต้าต้องเป็นตัวเลข 0 ขึ้นไปนะ'));

        if (newTitle) event.title = newTitle;
        if (newDesc)  event.desc  = newDesc;
        event.endTime    = newDate;
        event.endTimeStr = newTimeRaw;
        event.maxSlots   = newSlots;
        await event.save();

        return safeReply(modal, E(`✅ อัปเดตกิจกรรม **"${event.title}"** เรียบร้อยแล้ว!`));
    }
});

// ════════════════════════════════════════════════════════
//  SELECT MENU
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    const { customId, values, member, user } = interaction;
    const guildMember = member as GuildMember;
    const eventId     = values[0];

    if (customId === 'select_view_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        if (!event.active) return safeReply(interaction, E('❌ กิจกรรมนี้ปิดรับแล้วนะ'));
        return safeReply(interaction, {
            embeds:     [await buildEventEmbed(event, interaction.guild!)],
            components: [buildJoinButtons(eventId)],
            flags:      [MessageFlags.Ephemeral],
        });
    }

    if (customId === 'select_remove_member_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const allPeople: Array<{ userTag: string; type: string }> = [
            ...event.participants.map(t => ({ userTag: t, type: 'main' })),
            ...event.waitingList.map(p => ({ userTag: p.userTag, type: p.wantMain ? 'wait_main' : 'wait_reserve' })),
        ];
        if (!allPeople.length) return safeReply(interaction, E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));

        const typeLabel: Record<string, string> = { main: '🟢 ตัวจริง', wait_main: '⏳ รอคิว', wait_reserve: '💤 สำรอง' };
        const memberNames: Record<string, string> = {};
        for (const { userTag } of allPeople) {
            memberNames[userTag] = await resolveDisplayName(interaction.guild!, userTag);
        }

        const options = allPeople.slice(0, 25).map(({ userTag, type }) => ({
            label:       (memberNames[userTag] || userTag).substring(0, 25),
            description: typeLabel[type],
            value:       `${eventId}||${userTag}`.substring(0, 100),
        }));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_remove_member_confirm')
                .setPlaceholder('🗑️ เลือกสมาชิกที่จะลบออก...')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options),
        );
        return safeReply(interaction, {
            content:    `🗑️ **ลบรายชื่อ: ${event.title}**\nเลือกสมาชิกที่จะลบออกได้เลย (เลือกได้หลายคน)`,
            components: [row],
            flags:      [MessageFlags.Ephemeral],
        });
    }

    if (customId === 'select_remove_member_confirm') {
        const evId  = values[0].substring(0, values[0].indexOf('||'));
        const event = await EventModel.findOne({ eventId: evId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const removed: string[] = [];
        for (const val of values) {
            const userTag = val.substring(val.indexOf('||') + 2);
            const pIdx    = event.participants.indexOf(userTag);
            if (pIdx !== -1) {
                event.participants.splice(pIdx, 1);
                removed.push(userTag);
                const nextIdx = event.waitingList.findIndex(p => p.wantMain);
                if (nextIdx !== -1) {
                    const promoted = event.waitingList.splice(nextIdx, 1)[0];
                    event.participants.push(promoted.userTag);
                }
            } else {
                const wIdx = event.waitingList.findIndex(p => p.userTag === userTag);
                if (wIdx !== -1) { event.waitingList.splice(wIdx, 1); removed.push(userTag); }
            }
        }
        await event.save();

        const names = await Promise.all(removed.map(id => resolveDisplayName(interaction.guild!, id)));
        return safeReply(interaction, E(
            `✅ ลบ **${removed.length} คน** ออกจากกิจกรรม **"${event.title}"** เรียบร้อย!\n` +
            names.map(n => `• ${n}`).join('\n'),
        ));
    }

    if (customId === 'select_manual_add_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const modal = new ModalBuilder()
            .setCustomId(`modal_manual_add_${eventId}`)
            .setTitle(`📝 เพิ่มรายชื่อ: ${event.title.substring(0, 20)}`);
        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('manual_names')
                    .setLabel('User ID (1 บรรทัด = 1 คน)')
                    .setPlaceholder('123456789012345678\n987654321098765432')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true),
            ),
        );
        return interaction.showModal(modal);
    }

    if (customId === 'select_export_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const resolvedMain     = await resolveList(interaction.guild!, event.participants);
        const resolvedWait     = await Promise.all(event.waitingList.map(async p => ({
            ...p,
            display: await resolveDisplayName(interaction.guild!, p.userTag),
        })));
        const resolvedAttended = await resolveList(interaction.guild!, event.attendedUserTags ?? []);

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
            .setColor(0xeb459e);

        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    if (customId === 'select_edit_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const modal = new ModalBuilder()
            .setCustomId(`modal_edit_${eventId}`)
            .setTitle(`✏️ แก้ไข: ${event.title.substring(0, 20)}`);
        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('title').setLabel('ชื่อกิจกรรมใหม่').setStyle(TextInputStyle.Short).setRequired(false).setValue(event.title),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('desc').setLabel('รายละเอียดใหม่').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(event.desc || ''),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('time').setLabel('วันเวลาปิดรับใหม่ (ปปปป-ดด-วว ชช:นน)').setStyle(TextInputStyle.Short).setRequired(true).setValue(event.endTimeStr),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('slots').setLabel('โควต้าใหม่ (0 = ไม่จำกัด)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(event.maxSlots)),
            ),
        );
        return interaction.showModal(modal);
    }

    if (customId === 'select_delete_event') {
        const deleted = await EventModel.findOneAndDelete({ eventId });
        if (!deleted) return safeReply(interaction, E('❌ หากิจกรรมนี้ไม่เจอแล้ว อาจถูกลบไปก่อนหน้านี้แล้ว'));
        return safeReply(interaction, E(`🗑️ ลบกิจกรรม **"${deleted.title}"** ออกจากระบบเรียบร้อย!`));
    }

    if (customId === 'select_toggle_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        event.active = !event.active;
        await event.save();
        return safeReply(interaction, E(
            event.active
                ? `🟢 เปิดรับลงชื่อแล้ว — **"${event.title}"**`
                : `🔴 ปิดรับลงชื่อแล้ว — **"${event.title}"**`,
        ));
    }

    if (customId === 'select_checkin_event') {
        const event = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        const allPeople = [
            ...event.participants.map(t => ({ userTag: t })),
            ...event.waitingList.map(p => ({ userTag: p.userTag })),
        ];
        if (!allPeople.length) return safeReply(interaction, E('😅 ยังไม่มีใครลงชื่อในกิจกรรมนี้เลย'));
        return safeReply(interaction, await buildCheckinPage(interaction, event, 0));
    }

    if (customId === 'select_checkin_add') {
        const evId  = values[0].substring(0, values[0].indexOf('||'));
        const event = await EventModel.findOne({ eventId: evId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        if (!event.attendedUserTags) event.attendedUserTags = [];

        const newlyChecked: string[] = [];
        for (const val of values) {
            const userTag = val.substring(val.indexOf('||') + 2);
            if (event.attendedUserTags.includes(userTag)) continue;
            event.attendedUserTags.push(userTag);
            newlyChecked.push(userTag);
            await recordHistory(userTag, userTag, event.eventId, event.title);
        }
        await event.save();

        const total    = event.participants.length + event.waitingList.length;
        const nameList = newlyChecked.length
            ? newlyChecked.map(t => `• ${stripMention(t)}`).join('\n')
            : '_ทุกคนที่เลือกเช็คแล้วทั้งหมด_';
        return safeReply(interaction, E(
            `✅ เช็คชื่อเพิ่มสำเร็จ! **${newlyChecked.length}** คน\n${nameList}\n\n` +
            `📊 รวมเช็คแล้ว ${event.attendedUserTags.length} / ${total} คน`,
        ));
    }

    if (customId === 'select_checkin_remove') {
        const evId  = values[0].substring(0, values[0].indexOf('||'));
        const event = await EventModel.findOne({ eventId: evId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));

        const removed: string[] = [];
        for (const val of values) {
            const userTag = val.substring(val.indexOf('||') + 2);
            const idx     = (event.attendedUserTags ?? []).indexOf(userTag);
            if (idx !== -1) {
                event.attendedUserTags.splice(idx, 1);
                removed.push(userTag);
                const uid = extractUserId(userTag);
                if (uid) {
                    await HistoryModel.findOneAndUpdate(
                        { userId: uid },
                        { $pull: { records: { eventId: event.eventId } } },
                    );
                }
            }
        }
        await event.save();

        const total    = event.participants.length + event.waitingList.length;
        const nameList = removed.map(t => `• ${stripMention(t)}`).join('\n');
        return safeReply(interaction, E(
            `↩️ ยกเลิกเช็คชื่อ **${removed.length}** คนเรียบร้อย\n${nameList}\n\n` +
            `📊 รวมเช็คแล้ว ${event.attendedUserTags.length} / ${total} คน`,
        ));
    }

    if (customId === 'select_myqueue_event') {
        const event   = await EventModel.findOne({ eventId });
        if (!event) return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
        const userTag = getUserTag(guildMember, user);

        const mainIdx = event.participants.indexOf(userTag);
        if (mainIdx !== -1)
            return safeReply(interaction, E(`✅ คุณอยู่ใน **ตัวจริง** ลำดับที่ **${mainIdx + 1}** — **"${event.title}"**`));

        const waitIdx = event.waitingList.findIndex(p => p.userTag === userTag);
        if (waitIdx !== -1) {
            const p      = event.waitingList[waitIdx];
            const pos    = event.waitingList.slice(0, waitIdx + 1).filter(w => w.wantMain === p.wantMain).length;
            const typeStr = p.wantMain ? '' : '';
            return safeReply(interaction, E(`⏳ คุณอยู่ใน **${typeStr}** ลำดับที่ **${pos}** — **"${event.title}"**`));
        }

        return safeReply(interaction, E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
    }
});

// ════════════════════════════════════════════════════════
//  BUTTON: join_ / wait_ / leave_ / register_btn
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (
        interaction.customId.startsWith('main_') ||
        interaction.customId.startsWith('action_') ||
        interaction.customId.startsWith('checkin_page||') ||
        interaction.customId.startsWith('rlp||')
    ) return;

    const { customId, member, user } = interaction;
    const guildMember = member as GuildMember;

    // ── ปุ่มลงทะเบียน ──────────────────────────────────
    if (customId === 'register_btn') {
        const modal = new ModalBuilder()
            .setCustomId('modal_register')
            .setTitle('📋 ลงทะเบียนสมาชิก ORION');
        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('reg_roblox_username')
                    .setLabel('Roblox Username')
                    .setPlaceholder('เช่น ORIONxIT_Candybibi')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('reg_nickname')
                    .setLabel('ชื่อเล่น')
                    .setPlaceholder('เช่น แคนดี้')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('reg_birthday')
                    .setLabel('วันเกิด (วว/ดด)')
                    .setPlaceholder('เช่น 25/12')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
        return interaction.showModal(modal);
    }

    let action = 'leave';
    if (customId.startsWith('join_'))  action = 'join';
    if (customId.startsWith('wait_'))  action = 'wait';

    const eventId = customId.replace(`${action}_`, '');

    if (checkCooldown(user.id, eventId))
        return safeReply(interaction, E('⏱️ ใจเย็นๆ นะ รอแป๊บนึงแล้วลองใหม่!'));

    const event = await EventModel.findOne({ eventId });
    if (!event)  return safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว'));
    if (!event.active) return safeReply(interaction, E('❌ กิจกรรมนี้ปิดรับแล้วนะ'));

    const userTag  = getUserTag(guildMember, user);
    const isJoined =
        event.participants.includes(userTag) ||
        event.waitingList.some(p => p.userTag === userTag);

    if (action === 'join') {
        if (isJoined) return safeReply(interaction, E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));

        if (event.maxSlots === 0 || event.participants.length < event.maxSlots) {
            event.participants.push(userTag);
            await event.save();
            await safeReply(interaction, E('✅ ลงชื่อ **ตัวจริง** เรียบร้อยแล้ว เจอกันนะ! 🎉'));
        } else {
            event.waitingList.push({ userTag, wantMain: true });
            await event.save();
            const pos = event.waitingList.filter(w => w.wantMain).length;
            await safeReply(interaction, E(`⏳ โควต้าเต็มแล้ว! คุณอยู่ในคิวสำรองลำดับที่ **${pos}** ถ้ามีคนถอนตัว เดี๋ยวแจ้ง DM ให้เลย 📩`));
        }
    } else if (action === 'wait') {
        if (isJoined) return safeReply(interaction, E('😅 ลงชื่อไปแล้วนะ ไม่ต้องกดซ้ำ~'));
        event.waitingList.push({ userTag, wantMain: false });
        await event.save();
        await safeReply(interaction, E('💤 บันทึกเป็น **สำรอง** แล้วนะ ถ้าเปลี่ยนใจอยากขึ้นตัวจริงก็ยกเลิกแล้วกดลงชื่อใหม่ได้เลย!'));
    } else if (action === 'leave') {
        let removed = false;

        if (event.participants.includes(userTag)) {
            event.participants.splice(event.participants.indexOf(userTag), 1);
            const nextIdx = event.waitingList.findIndex(p => p.wantMain);
            if (nextIdx !== -1) {
                const promoted = event.waitingList.splice(nextIdx, 1)[0];
                event.participants.push(promoted.userTag);
            }
            removed = true;
        } else {
            const idx = event.waitingList.findIndex(p => p.userTag === userTag);
            if (idx !== -1) { event.waitingList.splice(idx, 1); removed = true; }
        }

        if (!removed) return safeReply(interaction, E('😅 คุณยังไม่ได้ลงชื่อในกิจกรรมนี้นะ'));
        await event.save();
        await safeReply(interaction, E('👋 ยกเลิกการลงชื่อเรียบร้อย เปลี่ยนใจเมื่อไหร่ก็ลงใหม่ได้นะ~'));
    }

    try {
        const latest = await EventModel.findOne({ eventId });
        await interaction.message.edit({
            embeds: [await buildEventEmbed(latest!, interaction.guild!)],
        });
    } catch { /* หา message ไม่เจอก็ข้ามไป */ }
});

// ════════════════════════════════════════════════════════
//  BUTTON: checkin_page||
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('checkin_page||')) return;

    const parts   = interaction.customId.split('||');
    const eventId = parts[1];
    const page    = parseInt(parts[2], 10);

    const event = await EventModel.findOne({ eventId });
    if (!event) {
        try { return await interaction.update({ content: '😕 หากิจกรรมนี้ไม่เจอแล้ว', components: [], embeds: [] }); }
        catch { return await safeReply(interaction, E('😕 หากิจกรรมนี้ไม่เจอแล้ว')); }
    }

    const pageData = await buildCheckinPage(interaction, event, page);
    try { return await interaction.update(pageData as InteractionUpdateOptions); }
    catch { return await safeReply(interaction, pageData); }
});

// ════════════════════════════════════════════════════════
//  BUTTON: rlp|| (robloxlist pagination)
// ════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('rlp||')) return;

    const parts    = interaction.customId.split('||');
    const cacheKey = parts[1];
    const page     = parseInt(parts[2], 10);

    async function getRobloxPages(guildObj: Guild): Promise<{ pages: string[]; total: number }> {
        const syncs = await RobloxSyncModel.find({});
        const lines: string[] = [];
        for (const sync of syncs) {
            const m = await guildObj.members.fetch(sync.discordId).catch(() => null);
            const discordName = m ? m.displayName : `<@${sync.discordId}>`;
            lines.push(`**${discordName}**\n🎮 Roblox Username: \`${sync.robloxUsername || sync.lastDisplayName}\``);
        }
        const PAGE   = 10;
        const pages: string[] = [];
        for (let i = 0; i < lines.length; i += PAGE)
            pages.push(lines.slice(i, i + PAGE).join('\n\n'));
        return { pages, total: syncs.length };
    }

    let cached = robloxListCache.get(cacheKey);
    if (!cached) {
        const fresh = await getRobloxPages(interaction.guild!);
        robloxListCache.set(cacheKey, fresh);
        setTimeout(() => robloxListCache.delete(cacheKey), 10 * 60_000);
        cached = fresh;
    }

    const { pages, total } = cached;
    const safePage = Math.min(Math.max(page, 0), pages.length - 1);

    const embed = new EmbedBuilder()
        .setTitle(`📋 รายชื่อ Roblox ทั้งหมด (${total} คน)`)
        .setDescription(pages[safePage])
        .setColor(0x5865f2)
        .setFooter({ text: `หน้า ${safePage + 1}/${pages.length}  •  ทั้งหมด ${total} คน` });

    const components = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`rlp||${cacheKey}||${safePage - 1}`)
                .setLabel('◀ ก่อนหน้า')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
            new ButtonBuilder()
                .setCustomId(`rlp||${cacheKey}||${safePage + 1}`)
                .setLabel('▶ ถัดไป')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === pages.length - 1),
        ),
    ];

    try {
        await interaction.update({ embeds: [embed], components });
    } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 40060 || code === 10062) {
            await interaction.followUp({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
    }
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

client.login(BOT_TOKEN);
