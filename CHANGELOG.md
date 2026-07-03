# Changelog — Bot-Discord-ORION

ประวัติการอัปเดตทั้งหมดของบอท เรียงจากเวอร์ชันล่าสุดไปเก่าสุด
ใช้ระบบ [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`
- **MAJOR** — เปลี่ยนแปลงโครงสร้างใหญ่
- **MINOR** — เพิ่มฟีเจอร์ใหม่
- **PATCH** — แก้บัค/ปรับปรุงเล็กน้อย

---

## [Unreleased]

---

## [1.6.1]

### เพิ่ม
- บังคับกรอกวันเกิดตอนลงทะเบียน (`reg_birthday` เป็น required field)
- Validate วันที่จริงตอนลงทะเบียน (กัน `31/02`, `30/02` ที่ไม่มีในปฏิทินจริง)

---

## [1.6.0]

### เพิ่ม
- ระบบ Changelog (ไฟล์นี้) — บันทึกทุกอัปเดตนับจากนี้ไปแบบมี version

### ปรับปรุง
- แก้ N+1 query ใน `/robloxlist` — จาก fetch สมาชิกทีละคน (57 API call) เหลือ fetch ทั้งหมดครั้งเดียว
- แก้ N+1 query ใน `/birthdays` — ใช้ pattern เดียวกับ `/robloxlist`
- แก้ memory leak เล็กๆ ใน `cooldownMap` — เพิ่ม auto-cleanup ด้วย `setTimeout` กัน Map โตไม่มีที่สิ้นสุด

---

## [1.5.0]

### เพิ่ม
- `/reconcile` [แอดมิน] — สั่งเช็ค DB เทียบกับสมาชิกจริงทันที ไม่ต้องรอเที่ยงคืน
- `/shoplist` [แอดมิน] — ดูรายชื่อร้านเติมทั้งหมดพร้อมจำนวนกลุ่ม
- `/grouplist` [แอดมิน] — ดูรายชื่อกลุ่ม Roblox ทั้งหมดที่ track ไว้
- `/removegroup` [แอดมิน] — ลบกลุ่มออกจากระบบ track ทั้งหมด (TrackedGroups + ทุกร้าน + ทุกคนที่ track อยู่) พร้อม autocomplete
- `/systemstatus` [แอดมิน] — ดูสถานะระบบโดยรวม (MongoDB, uptime, จำนวนสมาชิก/กลุ่ม/ร้าน) ไม่ต้อง SSH
- ระบบ Reconciliation — เช็ค `RobloxSync` เทียบกับสมาชิกจริงใน server ทุกวันเที่ยงคืน ลบข้อมูลค้างอัตโนมัติถ้าบอทออฟไลน์ตอน `guildMemberRemove` เกิดขึ้น
- `/setbirthday` เพิ่ม option `user` — แอดมิน/สตาฟตั้งวันเกิดให้สมาชิกคนอื่นได้ (manual override)
- Validate วันที่จริงใน `/setbirthday` (กัน 31/02 ฯลฯ)

### ปรับปรุง
- `guildMemberRemove` ลบ `GroupTracker` ด้วย ไม่ใช่แค่ `RobloxSync` (กันข้อมูลค้าง/orphan ใน DB)

---

## [1.4.1]

### แก้ไข
- ลบข้อความ `(X กลุ่ม)` ออกจาก autocomplete ของ `shopname` ใน `/addshop` — กันสับสนว่าเป็นการสร้างร้านใหม่ทั้งที่จริงคือเลือกร้านเดิม

---

## [1.4.0]

### เพิ่ม
- Autocomplete ครบทุกจุด: `shopname` (`/addshop`, `/removeshop`, `/renameshop`), `groupid` (`/groupstatus`)
- `/groupstatus` — เปลี่ยน option `shop` เป็น required

### แก้ไข
- แก้บัค "Register Slash Commands ไม่ได้" — `/groupstatus` มี option required (`shop`) อยู่หลัง option ไม่ required ซึ่ง Discord API ไม่อนุญาต แก้ลำดับ option ใหม่
- เพิ่ม `client.setMaxListeners(20)` แก้ `MaxListenersExceededWarning` (บอทมี `interactionCreate` listener 12 ตัวแยกตามฟีเจอร์ เกิน default limit ของ Node)

### ปรับปรุง
- เปลี่ยนคำว่า "หมวด" เป็น "ร้าน" ทุกจุดที่แสดงผลให้ผู้ใช้เห็น (embed, ข้อความตอบกลับ)

---

## [1.3.0]

### เพิ่ม
- ระบบหมวดร้านเติม (Shop) — รวมหลายกลุ่ม Roblox เข้าหมวดเดียวกันได้ (กลุ่มเดียวอยู่ได้หลายหมวด)
  - `/addshop` [แอดมิน] — เพิ่มกลุ่มเข้าหมวด สร้างหมวดใหม่อัตโนมัติถ้ายังไม่มี
  - `/removeshop` [แอดมิน] — ลบกลุ่มออกจากหมวด หรือลบทั้งหมวด
  - `/renameshop` [แอดมิน] — เปลี่ยนชื่อหมวด กันชื่อชนกัน
- `/groupstatus` เพิ่ม option `shop` — กรองดูเฉพาะกลุ่มในหมวดนั้น
- Autocomplete: `groupid` สำหรับ `/addshop`, `/removeshop`

### แก้ไข
- แก้ race condition ใน `/addshop`, `/removeshop`, `/renameshop` — เปลี่ยนจาก find-then-save เป็น atomic `findOneAndUpdate` + `$addToSet`/`$pull`
- ลบ `unique: true` ที่ไม่มีผลจริงบน schema `Shop.shopName` (case-sensitive แต่แอปเช็คแบบไม่สนตัวพิมพ์ใหญ่เล็ก)

---

## [1.2.0]

### เพิ่ม
- ระบบ Multi-Group Tracker
  - Schema `GroupTracker`, `TrackedGroups`
  - `/addgroup` [แอดมิน] — เพิ่มกลุ่ม Roblox เข้าระบบ track แบบ global, sync ให้ทุกคนใน `RobloxSync` ทันที
  - `/groupstatus` — เช็คสถานะเข้ากลุ่ม + นับวันจนครบ 15 วัน (เติมได้แล้ว)
  - `checkGroupStatus()` — batch 10 คน/รอบ ทุก 10 นาที เช็คเฉพาะคนที่ status `pending`
  - `/register` เพิ่ม auto-track ทุกกลุ่มที่มีอยู่แล้วให้คนลงทะเบียนใหม่ทันที
- Wrapper function `fetchRobloxAPI()` — รวมทุกจุดที่เรียก Roblox API พร้อม retry/backoff เมื่อโดน HTTP 429 (เคารพ header `Retry-After`)
- Schema `LockedChannel` — persist สถานะห้องที่ล็อคไว้ลง MongoDB กันบอท restart แล้วปลดล็อคโดยไม่รู้ตัว

### แก้ไข
- **บัคร้ายแรง:** URL ผิด domain ใน `checkGroupStatus()` — `users.roblox.com` ควรเป็น `groups.roblox.com` ทำให้เช็คกลุ่มไม่ได้เลย (404 ทุกครั้ง)
- แก้ deprecation warning `new: true` → `returnDocument: 'after'` ใน mongoose
- แก้ logic `nicknameWrong` ใน Roblox Name Sync — เดิมเทียบกับค่าที่สร้างจาก DB เอง ไม่ได้เทียบกับชื่อ Discord ปัจจุบันจริง ทำให้ถ้ามีคนแก้ชื่อ Discord มือ บอทจะไม่เปลี่ยนกลับให้

### ปรับปรุง
- เพิ่ม delay Roblox API sync จาก 500ms → 1500ms ต่อคน กัน rate limit
- เปลี่ยนระบบ sync หลักเป็น batch 10 คน/รอบ ทุก 10 นาที (จากเดิม sync ทุกคนรวดเดียวทุก 5 นาที)
- เพิ่ม log แสดง Roblox Display Name + ชื่อกลุ่มจริง แทน Discord ID / Group ID ดิบๆ

---

## [1.1.0]

### เพิ่ม
- ข้อความ "หากระบบมีปัญหาติดต่อผู้พัฒนา" ใน `/setup` และ `/setup-register`

### แก้ไข
- ลบ placeholder ที่ไม่จำเป็นออกจาก modal ลงทะเบียน (`reg_roblox_username`, `reg_nickname`)
- ปรับข้อความคำอธิบายในฟอร์มลงทะเบียนให้กระชับขึ้น

---

## [1.0.0]

เวอร์ชันฐานก่อนเริ่มบันทึก changelog — ระบบหลักที่มีอยู่แล้ว:
- ระบบจัดการกิจกรรม (Event Management) พร้อม waiting list
- ระบบล็อคห้อง (`/lock`, `/unlock`)
- ระบบลงทะเบียน Roblox + Sync ชื่อ Discord อัตโนมัติ (`/register`, `/unregister`, `/forcesyncroblox`)
- ระบบสมาชิกและวันเกิด (`/memberlist`, `/birthdays`, `/setbirthday`)

---

## หมายเหตุ

- ทุกอัปเดตของ Roblox Name Sync และ Group Tracker ทำงานแบบ **batch 10 คน/รอบ ทุก 10 นาที** เพื่อกัน Roblox API rate limit
- Reconciliation job รันทุกวันเที่ยงคืนเวลาไทย เป็น safety net คู่กับ event `guildMemberRemove`
