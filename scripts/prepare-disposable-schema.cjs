const { Pool } = require('pg');
const contract = require('../prisma/contract.json');
const url = new URL(process.env.NOTIFICATION_TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port || url.port === '5432' || url.pathname !== '/metro_disposable' ||
    ['host', 'hostaddr', 'port'].some(key => url.searchParams.has(key))) {
  throw new Error('Only a dedicated disposable loopback database is supported.');
}
const pool = new Pool({ connectionString: url.toString() });
const quote = name => '"' + name.replaceAll('"', '""') + '"';
async function prepare() {
  const tables = contract.storage.namespaces.public.entries.table;
  for (const [name, table] of Object.entries(tables)) {
    const columns = Object.entries(table.columns).map(([column, info]) => {
      let type = info.nativeType;
      let suffix = '';
      if (info.default?.expression === 'autoincrement()') type = 'serial';
      else if (info.default?.expression === 'now()') suffix = ' DEFAULT now()';
      else if (info.default?.kind === 'literal') {
        const value = info.default.value;
        suffix = ' DEFAULT ' + (typeof value === 'string' ? "'" + value.replaceAll("'", "''") + "'" : String(value));
      }
      if (info.typeParams?.precision != null) type += `(${info.typeParams.precision})`;
      return `${quote(column)} ${type}${info.nullable ? '' : ' NOT NULL'}${suffix}`;
    });
    columns.push(`PRIMARY KEY (${table.primaryKey.columns.map(quote).join(',')})`);
    for (const unique of table.uniques) columns.push(`UNIQUE (${unique.columns.map(quote).join(',')})`);
    await pool.query(`CREATE TABLE public.${quote(name)} (${columns.join(',')})`);
  }
  for (const [name, table] of Object.entries(tables)) {
    for (const fk of table.foreignKeys) await pool.query(`ALTER TABLE public.${quote(name)} ADD FOREIGN KEY
      (${fk.source.columns.map(quote).join(',')}) REFERENCES public.${quote(fk.target.tableName)}
      (${fk.target.columns.map(quote).join(',')})${fk.onDelete === 'cascade' ? ' ON DELETE CASCADE' : ''}`);
  }
}
prepare().then(() => console.log('Disposable schema prepared.'))
  .catch(() => { console.error('Disposable schema preparation failed.'); process.exitCode = 1; })
  .finally(() => pool.end());
