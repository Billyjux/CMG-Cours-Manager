const app = require('./app');
const { DB_FILE } = require('./db');

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Course manager API listening on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
});
