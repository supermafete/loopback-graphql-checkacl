import * as _ from 'lodash';
import {
  searchModelName,
  singularModelName,
  pluralModelName,
  methodName,
  edgeTypeName,
  sharedRelations,
  idToCursor,
} from './utils';
import { findRelated, findAll, findOne } from './execution';
import { IProperty, ITypesHash } from './interfaces';

/*** Loopback Types - GraphQL types
        any - JSON
        Array - [JSON]
        Boolean = boolean
        Buffer - not supported
        Date - Date (custom scalar)
        GeoPoint - not supported
        null - not supported
        Number = float
        Object = JSON (custom scalar)
        String - string
    ***/

let types: ITypesHash = {};

const exchangeTypes = {
  'any': 'JSON',
  'Any': 'JSON',
  'Number': 'Int',
  'number': 'Int',
  'Object': 'JSON',
  'object': 'JSON',
};

const SCALARS = {
  any: 'JSON',
  number: 'Float',
  string: 'String',
  boolean: 'Boolean',
  objectid: 'ID',
  date: 'Date',
  object: 'JSON',
  now: 'Date',
  guid: 'ID',
  uuid: 'ID',
  uuidv4: 'ID',
  geopoint: 'GeoPoint',
};

const PAGINATION = 'filter: JSON, after: String, first: Int, before: String, last: Int, skip: Int, orderBy: String';
const SEARCH = 'searchTerm: String, after: String, first: Int, before: String, last: Int, skip: Int, orderBy: String';
const FILTER = 'filter: JSON';
const IDPARAMS = 'id: ID!';

function getScalar(type: string) {
  return SCALARS[type.toLowerCase().trim()];
}

function toTypes(union: string[]) {
  return _.map(union, type => {
    return getScalar(type) ? getScalar(type) : type;
  });
}

function mapProperty(model: any, property: any, modelName: string, propertyName: any  ) {
  if (property.deprecated) {
    return;
  }
  types[modelName].fields[propertyName] = {
    required: property.required,
    hidden: model.definition.settings.hidden && model.definition.settings.hidden.indexOf(propertyName) !== -1,
  };
  let currentProperty = types[modelName].fields[propertyName];

  let typeName = `${modelName}_${propertyName}`;
  let propertyType = property.type;

  if (propertyType.name === 'Array') { // JSON Array
    currentProperty.list = true;
    currentProperty.gqlType = 'JSON';
    currentProperty.scalar = true;
    return;
  }

  if (_.isArray(property.type)) {
    currentProperty.list = true;
    propertyType = property.type[0];
  }

  let scalar = getScalar(propertyType.name);
  if (property.defaultFn) {
    scalar = getScalar(property.defaultFn);
  }
  if (scalar) {
    currentProperty.scalar = true;
    currentProperty.gqlType = scalar;
    if (property.enum) { // enum has a dedicated type but no input type is required
      types[typeName] = {
        values: property.enum,
        category: 'ENUM',
      };
      currentProperty.gqlType = typeName;
    }
  }

  if (propertyType.name === 'ModelConstructor' && property.defaultFn !== 'now') {
    currentProperty.gqlType = propertyType.modelName;
    let union = propertyType.modelName.split('|');
    //type is a union
    if (union.length > 1) { // union type
      types[typeName] = { // creating a new union type
        category: 'UNION',
        values: toTypes(union),
      };
    } else if (propertyType.settings && propertyType.settings.anonymous && propertyType.definition) {
      currentProperty.gqlType = typeName;
      types[typeName] = {
        category: 'TYPE',
        input: true,
        fields: {},
      }; // creating a new type
      _.forEach(propertyType.definition.properties, (p, key) => {
        mapProperty(propertyType, p, typeName, key);
      });
    }
  }
}

function mapRelation(rel: any, modelName: string, relName: string) {
  console.log('AST: map Relation', modelName, rel.type, relName );
  // const relNamePlural = relName + 's';
  if (rel.type === 'hasOne') {
    types[modelName].fields[relName] = {
      relation: true,
      embed: rel.embed,
      gqlType: rel.modelTo.modelName,
      args: FILTER,
      resolver: (obj, args, context) => {
        return findRelated(rel, obj, args, context);
      },
    };
  } else if (rel.type === 'belongsTo') {
      types[modelName].fields[relName] = {
        relation: true,
        embed: rel.embed,
        gqlType: rel.modelTo.modelName,
        args: FILTER,
        resolver: (obj, args, context) => {
          return findRelated(rel, obj, args, context);
        },
      };
  } else if (rel.type === 'hasMany') {
      types[modelName].fields[relName] = {
        relation: true,
        embed: rel.embed,
        list: true,
        gqlType: [rel.modelTo.modelName],
        args: PAGINATION,
        resolver: (obj, args, context) => {
          return findRelated(rel, obj, args, context);
        },
      };
  } else {
    console.log("NO CONNECTION TYPE RECOGNIZED");
  }
}

function addRemoteHooks(model: any) {

  _.map(model.sharedClass._methods, (method: any) => {
    if (method.accessType !== 'READ' && method.http.path) {
      let acceptingParams = '',
        returnType = 'JSON';
      method.accepts.map(function (param) {
        let paramType = '';
        if (typeof param.type === 'object') {
          paramType = 'JSON';
        } else {
          if (!SCALARS[param.type.toLowerCase()]) {
            paramType = `${param.type}Input`;
          } else {
            paramType = _.upperFirst(param.type);
          }
        }
        if (param.arg) {
          acceptingParams += `${param.arg}: ${exchangeTypes[paramType] || paramType} `;
        }
      });
      if (method.returns && method.returns[0]) {
        if (!SCALARS[method.returns[0].type] && typeof method.returns[0].type !== 'object') {
          returnType = `${method.returns[0].type}`;
        } else {
          returnType = `${_.upperFirst(method.returns[0].type)}`;
          if (typeof method.returns[0].type === 'object') {
            returnType = 'JSON';
          }
        }
      }
      types.Mutation.fields[`${methodName(method, model)}`] = {
        relation: true,
        args: acceptingParams,
        gqlType: `${exchangeTypes[returnType] || returnType}`,
      };
    }
  });
}

function mapRoot(model) {
  types.Query.fields[singularModelName(model)] = {
    relation: true,
    args: IDPARAMS,
    root: true,
    gqlType: singularModelName(model),
    resolver: (obj, args, context) => {
      findOne(model, obj, args, context);
    },
  };

  types.Query.fields[pluralModelName(model)] = {
    relation: true,
    root: true,
    args: PAGINATION,
    list: true,
    gqlType: singularModelName(model),
    resolver: (obj, args, context) => {
      findAll(model, obj, args, context);
    },
  };

  types.Mutation.fields[`update${singularModelName(model)}`] = {
    relation: true,
    args: `obj: ${singularModelName(model)}Input!`,
    gqlType: singularModelName(model),
    resolver: (context, args) => model.upsert(args.obj),
  };

  types.Mutation.fields[`create${singularModelName(model)}`] = {
    relation: true,
    args: `obj: ${singularModelName(model)}Input!`,
    gqlType: singularModelName(model),
    resolver: (context, args) => model.upsert(args.obj),
  };

  types.Mutation.fields[`delete${singularModelName(model)}`] = {
    relation: true,
    args: IDPARAMS,
    gqlType: ` ${singularModelName(model)}`,
    resolver: (context, args) => {
      return model.findById(args.id)
        .then(instance => instance.destroy());
    },
  };

  // _.each(model.sharedClass.methods, method => {
  //     if (method.accessType !== 'READ' && method.http.path) {
  //         let methodName = methodName(method, model);
  //         types.Mutation.fields[methodName] = {
  //             gqlType: `${generateReturns(method.name, method.returns)}`,
  //             args: `${generateAccepts(method.name, method.accepts)}`
  //         }

  //         return `${methodName(method)}
  //                     ${generateAccepts(method.name, method.accepts)}

  //                 : JSON`;
  //     } else {
  //         return undefined;
  //     }
  // });
  addRemoteHooks(model);
}

function mapThrough(model) {
  let relations = model.definition.settings.relations;
  let mutationArgs = {};
  let mutationArgsStr = '';

  for (let relationKey in relations) {
    if (relationKey) {
      let relation = relations[relationKey];
      mutationArgs[relation.foreignKey] = "ID!",
      mutationArgsStr += relation.foreignKey + `: ID!,`;
    }
  }
  mutationArgsStr = mutationArgsStr.replace(/,$/, '');

  types.Mutation.fields[`addTo${singularModelName(model)}`] = {
    relation: true,
    args: mutationArgsStr,
    gqlType: ` ${singularModelName(model)}`,
    resolver: (context, args) => model.upsert(args),
  };

  types.Mutation.fields[`removeFrom${singularModelName(model)}`] = {
    relation: true,
    list: true,
    args: mutationArgsStr,
    gqlType: ` ${singularModelName(model)}`,
    resolver: (context, args) => model.remove,
  };

  // addRemoteHooks(model);
}

function mapSearch(model) {

  types.Query.fields[searchModelName(model)] = {
    relation: true,
    root: true,
    args: SEARCH,
    list: true,
    gqlType: singularModelName(model),
    resolver: (obj, args, context) => {
      findAll(model, obj, args, context);
    },
  };
}

export function abstractTypes(models: any[]): ITypesHash {
  //building all models types & relationships
  types.pageInfo = {
    category: 'TYPE',
    fields: {
      hasNextPage: {
        gqlType: 'Boolean',
        required: true,
      },
      hasPreviousPage: {
        gqlType: 'Boolean',
        required: true,
      },
      startCursor: {
        gqlType: 'String',
      },
      endCursor: {
        gqlType: 'String',
      },
    },
  };
  types.Query = {
    category: 'TYPE',
    fields: {},
  };
  types.Mutation = {
    category: 'TYPE',
    fields: {},
  };

  _.forEach(models, model => {
    if (model.shared) {
      mapRoot(model);
    }
    if (model.definition.settings.modelThrough) {
      mapThrough(model);
    }
    if (model.definition.settings.elasticSearch) {
      mapSearch(model);
    }
    types[singularModelName(model)] = {
      category: 'TYPE',
      input: true,
      fields: {},
    };
    _.forEach(model.definition.properties, (property, key) => {
      mapProperty(model, property, singularModelName(model), key);
    });

    _.forEach(sharedRelations(model), rel => {
      mapRelation(rel, singularModelName(model), rel.name);
    });
  });
  return types;
}
