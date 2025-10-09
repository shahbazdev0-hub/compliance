// columns.js
// Run: node columns.js
//
// Prereqs:
//   npm install pg
//
// Purpose:
//   Connects to Retool Postgres DB and lists all column names for "submissions" table

const { Client } = require("pg");

const PG_CONNECTION_STRING =
  "postgresql://retool:npg_Ar0ZIzDg2Ocw@ep-sweet-breeze-a6zz899z.us-west-2.retooldb.com/retool?sslmode=require";

async function main() {
  const client = new Client({ connectionString: PG_CONNECTION_STRING });

  try {
    await client.connect();
    console.log("[db] Connected.");

    const res = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'submissions'
      ORDER BY ordinal_position;
    `);

    console.log("Columns in 'submissions' table:");
    res.rows.forEach((row, idx) => {
      console.log(`${idx + 1}. ${row.column_name} (${row.data_type})`);
    });
  } catch (err) {
    console.error("[db] Error:", err);
  } finally {
    await client.end();
    console.log("[db] Connection closed.");
  }
}

main();
