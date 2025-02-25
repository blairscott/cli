import Umzug from 'umzug';
import _ from 'lodash';

import helpers from '../helpers/index';

const Sequelize = helpers.generic.getSequelize();

export function logMigrator(s) {
  if (s.indexOf('Executing') !== 0) {
    helpers.view.log(s);
  }
}

function getSequelizeInstance() {
  let config = null;

  try {
    config = helpers.config.readConfig();
  } catch (e) {
    helpers.view.error(e);
  }

  config = _.defaults(config, { logging: logMigrator });

  try {
    return new Sequelize(config);
  } catch (e) {
    helpers.view.error(e);
  }
}

export async function getMigrator(type, args) {
  if (!(helpers.config.configFileExists() || args.url)) {
    helpers.view.error(
      `Cannot find "${helpers.config.getConfigFile()}". Have you run "sequelize init"?`
    );
    process.exit(1);
  }

  const sequelize = getSequelizeInstance();

  helpers.view.log('Got sequelize instance');
  
  const migrator = new Umzug({
    storage: helpers.umzug.getStorage(type),
    storageOptions: helpers.umzug.getStorageOptions(type, { sequelize }),
    logging: helpers.view.log,
    migrations: {
      params: [sequelize.getQueryInterface(), Sequelize],
      path: helpers.path.getPath(type),
      pattern: /^(?!.*\.d\.ts$).*\.(cjs|js|ts)$/,
    },
  });

  helpers.view.log('Time to authenticate');


  return sequelize
    .authenticate()
    .then(() => {
      helpers.view.log('Authenticated in sequelize');
      // Check if this is a PostgreSQL run and if there is a custom schema specified, and if there is, check if it's
      // been created. If not, attempt to create it.
      if (helpers.version.getDialectName() === 'pg') {
        const customSchemaName = helpers.umzug.getSchema('migration');
        helpers.view.log('Schema name: ' + customSchemaName);
        if (customSchemaName && customSchemaName !== 'public') {
          return sequelize.createSchema(customSchemaName);
        }
      }
    })
    .then(() => migrator)
    .catch((e) => helpers.view.error(e));
}

export function ensureCurrentMetaSchema(migrator) {
  const queryInterface = migrator.options.storageOptions.sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;
  const columnName = migrator.options.storageOptions.columnName;
  helpers.view.log('ensureCurrentMetaSchema');

  return ensureMetaTable(queryInterface, tableName)
    .then((table) => {
      const columns = Object.keys(table);

      if (columns.length === 1 && columns[0] === columnName) {
        return;
      } else if (columns.length === 3 && columns.indexOf('createdAt') >= 0) {
        // If found createdAt - indicate we have timestamps enabled
        helpers.umzug.enableTimestamps();
        return;
      }
    })
    .catch(() => {});
}

function ensureMetaTable(queryInterface, tableName) {
  return queryInterface.showAllTables().then((tableNames) => {
    if (tableNames.indexOf(tableName) === -1) {
      throw new Error('No MetaTable table found.');
    }
    return queryInterface.describeTable(tableName);
  });
}

/**
 * Add timestamps
 *
 * @return {Promise}
 */
export function addTimestampsToSchema(migrator) {
  const sequelize = migrator.options.storageOptions.sequelize;
  const queryInterface = sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;

  return ensureMetaTable(queryInterface, tableName).then((table) => {
    if (table.createdAt) {
      return;
    }

    return ensureCurrentMetaSchema(migrator)
      .then(() => queryInterface.renameTable(tableName, tableName + 'Backup'))
      .then(() => {
        const queryGenerator =
          queryInterface.QueryGenerator || queryInterface.queryGenerator;
        const sql = queryGenerator.selectQuery(tableName + 'Backup');
        return helpers.generic.execQuery(sequelize, sql, {
          type: 'SELECT',
          raw: true,
        });
      })
      .then((result) => {
        const SequelizeMeta = sequelize.define(
          tableName,
          {
            name: {
              type: Sequelize.STRING,
              allowNull: false,
              unique: true,
              primaryKey: true,
              autoIncrement: false,
            },
          },
          {
            tableName,
            timestamps: true,
            schema: helpers.umzug.getSchema(),
          }
        );

        return SequelizeMeta.sync().then(() => {
          return SequelizeMeta.bulkCreate(result);
        });
      });
  });
}
