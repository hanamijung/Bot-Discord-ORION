require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGOTOKEN;

const History = mongoose.model('History', new mongoose.Schema({
    userId:  { type: String, unique: true },
    userTag: String,
    records: [{
        eventId:    String,
        eventTitle: String,
        attendedAt: { type: Date, default: Date.now },
    }],
}));

async function migrate_fix_history_userId() {
    console.log('[MIGRATE] เริ่ม migration: แก้ History userId จาก <@id> → id');
    const oldDocs = await History.find({ userId: /^<@/ });
    if (!oldDocs.length) {
        console.log('[MIGRATE] ไม่มีข้อมูลที่ต้องแก้');
        return;
    }
    let fixed = 0;
    for (const doc of oldDocs) {
        const cleanId = doc.userId.replace(/^<@!?/, '').replace(/>$/, '');
        if (/^\d{17,20}$/.test(cleanId)) {
            await History.findByIdAndUpdate(doc._id, { userId: cleanId });
            console.log(`[MIGRATE] แก้ userId: ${doc.userId} → ${cleanId}`);
            fixed++;
        } else {
            console.warn(`[MIGRATE] ⚠️ userId ไม่ใช่ตัวเลข ข้าม: ${doc.userId}`);
        }
    }
    console.log(`[MIGRATE] เสร็จแล้ว แก้ทั้งหมด ${fixed}/${oldDocs.length} records`);
}

async function main() {
    if (!MONGO_URI) {
        console.error('❌ ไม่เจอ MONGOTOKEN ใน .env');
        process.exit(1);
    }

    console.log('[MIGRATE] กำลังเชื่อมต่อ MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('[MIGRATE] เชื่อมต่อสำเร็จ');

    await migrate_fix_history_userId();

    await mongoose.disconnect();
    console.log('[MIGRATE] ปิดการเชื่อมต่อแล้ว เสร็จสิ้น ✅');
    process.exit(0);
}

main().catch(err => {
    console.error('[MIGRATE] error:', err.message);
    process.exit(1);
});
