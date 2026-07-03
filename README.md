# Bot-Discord-ORION

บอท Discord สำหรับชุมชน ORION CLUB (Roblox) — จัดการกิจกรรม, ลงทะเบียน/sync ชื่อ Roblox, ติดตามสถานะการเข้ากลุ่มร้านเติม, และระบบดูแลสมาชิกอัตโนมัติ

**เวอร์ชันปัจจุบัน:** `v1.6.1` — ดูรายละเอียดการอัปเดตทั้งหมดที่ [CHANGELOG.md](./CHANGELOG.md)

---

## ภาพรวมระบบ

| ระบบ | คำอธิบาย |
|---|---|
| 📅 จัดการกิจกรรม | สร้างกิจกรรม ลงชื่อเข้าร่วม มีคิวรอ (waiting list) ปิดรับอัตโนมัติเมื่อหมดเวลา |
| 🔒 ควบคุมห้อง | ล็อค/ปลดล็อคห้อง ลบข้อความคนที่ไม่มีสิทธิ์อัตโนมัติ (persist ผ่านบอท restart) |
| 🎮 Roblox Sync | ลงทะเบียน Roblox ผูกกับ Discord, sync ชื่อ Discord ให้ตรงกับ Roblox Display Name อัตโนมัติทุก 10 นาที |
| 🎂 วันเกิด | บันทึกวันเกิดสมาชิก แจ้งเตือนอัตโนมัติทุกวันเที่ยงคืน |
| 🏷️ Multi-Group Tracker | ติดตามว่าสมาชิกเข้ากลุ่ม Roblox ของร้านเติมแล้วหรือยัง นับวันจนครบ 15 วัน |
| 🏪 ระบบร้านเติม (Shop) | จัดกลุ่ม Roblox หลายกลุ่มเข้าเป็น "ร้าน" เดียวกัน (กลุ่มเดียวอยู่ได้หลายร้าน) |
| 🧹 Data Reconciliation | เช็ค DB เทียบกับสมาชิกจริงทุกวัน ลบข้อมูลค้างอัตโนมัติเมื่อมีคนออกจาก server |

---

## การติดตั้ง

### สิ่งที่ต้องมี
- Node.js (แนะนำ v18+)
- MongoDB (ใช้ MongoDB Atlas หรือ self-hosted ก็ได้)
- Discord Bot Token ([สร้างที่ Discord Developer Portal](https://discord.com/developers/applications))

### ขั้นตอน

```bash
git clone https://github.com/hanamijung/Bot-Discord-ORION.git
cd Bot-Discord-ORION
npm install
```

สร้างไฟล์ `.env` ที่ root:

```env
TOKEN=your_discord_bot_token
MONGO_URI=your_mongodb_connection_string
GUILD_ID=your_main_guild_id
CLIENT_ID=your_bot_client_id
```

รันบอท:

```bash
node index.js
```

หรือใช้ PM2 สำหรับ production (แนะนำ):

```bash
pm2 start index.js --name Bot-Discord
pm2 logs Bot-Discord
```

---

## คำสั่งทั้งหมด

### สมาชิกทั่วไป

| คำสั่ง | คำอธิบาย |
|---|---|
| `/register` | ลงทะเบียน Roblox (ผ่าน modal: username, ชื่อเล่น, วันเกิด) |
| `/unregister` | ยกเลิกการลงทะเบียน |
| `/myprofile` | ดูโปรไฟล์ Roblox ของตัวเอง |
| `/robloxinfo` | ดูข้อมูล Roblox ของสมาชิกที่ระบุ |
| `/robloxlist` | ดูรายชื่อ Roblox ของสมาชิกทั้งหมด (แบ่งหน้า) |
| `/memberlist` | ดูรายชื่อสมาชิกทั้งหมด |
| `/birthdays` | ดูวันเกิดที่กำลังจะมาถึงในเดือนนี้ |
| `/setbirthday` | ตั้ง/แก้ไขวันเกิดของตัวเอง |
| `/groupstatus` | เช็คสถานะการเข้ากลุ่มร้านเติม นับวันว่าเติมได้แล้วหรือยัง |

### แอดมิน/สตาฟ

| คำสั่ง | คำอธิบาย |
|---|---|
| `/setup` | สร้างแผงจัดการกิจกรรมในห้องนั้น |
| `/setup-register` | สร้างแผงปุ่มลงทะเบียนในห้องนั้น |
| `/lock` / `/unlock` | ล็อค/ปลดล็อคห้อง |
| `/forcesyncroblox` | บังคับ sync ชื่อ Roblox ของสมาชิกทันที |
| `/setbirthday user:` | ตั้งวันเกิดให้สมาชิกคนอื่น |
| `/addgroup` | เพิ่มกลุ่ม Roblox เข้าระบบติดตาม (sync ให้ทุกคนทันที) |
| `/removegroup` | ลบกลุ่มออกจากระบบติดตามทั้งหมด |
| `/grouplist` | ดูรายชื่อกลุ่มทั้งหมดที่ track ไว้ |
| `/addshop` | เพิ่มกลุ่มเข้าร้านเติม (สร้างร้านใหม่อัตโนมัติถ้ายังไม่มี) |
| `/removeshop` | ลบกลุ่มออกจากร้าน หรือลบทั้งร้าน |
| `/renameshop` | เปลี่ยนชื่อร้าน |
| `/shoplist` | ดูรายชื่อร้านเติมทั้งหมด |
| `/reconcile` | สั่งเช็ค DB เทียบกับสมาชิกจริงทันที |
| `/systemstatus` | ดูสถานะระบบโดยรวม (MongoDB, uptime, จำนวนข้อมูล) |

---

## สถาปัตยกรรม

### Database Schemas (MongoDB)

| Schema | เก็บอะไร |
|---|---|
| `Event` | ข้อมูลกิจกรรม ผู้เข้าร่วม คิวรอ |
| `History` | ประวัติการเข้าร่วมกิจกรรมของแต่ละคน |
| `RobloxSync` | ผูก Discord ↔ Roblox (username, displayName, วันเกิด) |
| `GroupTracker` | สถานะการเข้ากลุ่มของแต่ละคน (pending/joined, วันที่เข้า) |
| `TrackedGroups` | รายการกลุ่ม Roblox ที่เปิด track แบบ global |
| `Shop` | หมวดร้านเติม รวมหลายกลุ่มเข้าด้วยกัน |
| `LockedChannel` | ห้องที่ถูกล็อคไว้ (persist กันบอท restart) |

### Background Jobs

| งาน | ความถี่ | รูปแบบ |
|---|---|---|
| Roblox Name Sync | ทุก 10 นาที | batch 10 คน/รอบ หมุนวน |
| Group Tracker Check | ทุก 10 นาที | batch 10 คน/รอบ เช็คเฉพาะคน pending |
| Birthday Check | ทุกวันเที่ยงคืน (เวลาไทย) | เช็คทั้งหมดรอบเดียว |
| Data Reconciliation | ทุกวันเที่ยงคืน (เวลาไทย) | เทียบ DB กับสมาชิกจริงทั้งหมด |
| Event Auto-close | ทุก 1 นาที | เช็คกิจกรรมที่หมดเวลา |

**ทำไมต้องเป็น batch?** เพื่อกัน Roblox API rate limit (HTTP 429) — ยิง API พร้อมกันเยอะเกินไปจะโดนบล็อกชั่วคราว จึงแบ่งเป็นกลุ่มละ 10 คน + delay 1500ms ต่อคน และมี retry/backoff อัตโนมัติผ่าน `fetchRobloxAPI()` wrapper

### Resilience

- **Reconciliation job** — ถ้าบอทออฟไลน์ตอนสมาชิกออกจาก server พอดี (`guildMemberRemove` ไม่ทำงานเพราะ Discord ไม่ replay event เก่า) ระบบนี้จะจับข้อมูลค้างและลบให้ในรอบถัดไป ไม่เกิน 24 ชั่วโมง
- **Locked channel persistence** — สถานะห้องที่ล็อคเก็บใน MongoDB โหลดกลับมาอัตโนมัติทุกครั้งที่บอท restart
- **Retry with backoff** — ทุกการเรียก Roblox API ผ่าน wrapper กลางที่ retry อัตโนมัติเมื่อโดน rate limit

---

## การพัฒนาต่อ

โครงสร้างไฟล์หลัก:

```
Bot-Discord-ORION/
├── index.js          # โค้ดหลักทั้งหมด (schemas, commands, background jobs)
├── CHANGELOG.md       # ประวัติการอัปเดตทั้งหมด
├── README.md          # ไฟล์นี้
└── .env               # ตัวแปรลับ (ไม่ commit ขึ้น git)
```

ก่อน push การเปลี่ยนแปลงใหม่ทุกครั้ง:
1. ทดสอบ syntax: `node -c index.js`
2. อัปเดต `CHANGELOG.md` ในหัวข้อ `[Unreleased]`
3. Commit พร้อมข้อความสั้นกระชับ (ใต้ 50 ตัวอักษร) อธิบายว่าแก้อะไร

---

## ติดต่อ

หากระบบมีปัญหา ติดต่อผู้พัฒนา: `@ORIONxIT_CandyxD (แคนดี้)`
