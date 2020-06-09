const { dbGet } = require('../common')

const LAST_MIGRATION_KEY = 'last_migration'
const migrations = [
  require('./1-move-seeding-db.js')
]

class Migrations {
  constructor (dbs) {
    this.dbs = dbs
  }

  async ensureMigrated () {
    var lastMigration = await dbGet(this.dbs.migrations, LAST_MIGRATION_KEY)
    for (let i = 0; i < migrations.length; i++) {
      if (lastMigration && (i < lastMigration)) continue
      await migrations[i](this.dbs)
      lastMigration = i + 1
      await this.dbs.migrations.put(LAST_MIGRATION_KEY, lastMigration)
    }
  }
}

module.exports = Migrations
