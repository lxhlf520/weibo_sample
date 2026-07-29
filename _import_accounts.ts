import { getDb, closeDb } from './src/lib/db';
import { readFileSync } from 'fs';

async function main() {
  const db = await getDb();
  const raw = JSON.parse(readFileSync('c:/Users/13662/Desktop/weibo_accounts.json', 'utf-8'));

  const collection = db.collection('weibo_weibo_accounts');

  let imported = 0;
  let skipped = 0;

  for (const acc of raw) {
    // 检查是否已存在（按 weibo_uid）
    const exist = await collection.findOne({ weibo_uid: acc.weibo_uid });
    if (exist) {
      console.log(`  跳过（已存在）: ${acc.nickname} (uid: ${acc.weibo_uid})`);
      skipped++;
      continue;
    }

    await collection.insertOne({
      ...acc,
      id: acc._id,  // _id 同时作为 id
      daily_comment_count: 0,
      max_daily_comments: 50,
      status: 'active',
    });
    console.log(`  导入: ${acc.nickname} (uid: ${acc.weibo_uid})`);
    imported++;
  }

  console.log(`\n导入完成: ${imported} 新增 / ${skipped} 跳过`);
  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
