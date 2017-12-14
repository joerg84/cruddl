import { ArangoDBAdapter } from '../../src/database/arangodb/arangodb-adapter';
import {
    graphql, GraphQLError, GraphQLSchema, OperationDefinitionNode, parse, separateOperations, Source
} from 'graphql';
import * as fs from 'fs';
import * as path from 'path';
import { createSchema } from '../../src/schema/schema-builder';
import { addQueryResolvers } from '../../src/query/query-resolvers';
import { createTempDatabase, initTestData, TestDataEnvironment } from './initialization';
import * as stripJsonComments from 'strip-json-comments';
import { PlainObject } from '../../src/utils/utils';
import {SchemaConfig, SchemaPartConfig} from "../../src/config/schema-config";

interface TestResult {
    actualResult: any
    expectedResult: any
}

export interface RegressionSuiteOptions {
    saveActualAsExpected?: boolean
}

export class RegressionSuite {
    private schema: GraphQLSchema;
    private testDataEnvironment: TestDataEnvironment;
    private _isSetUpClean = false;

    constructor(private readonly path: string, private options: RegressionSuiteOptions = {}) {

    }

    private get testsPath() {
        return path.resolve(this.path, 'tests');
    }

    private async setUp() {
        const dbConfig = await createTempDatabase();
        const dbAdapter = new ArangoDBAdapter(dbConfig);

        const schemaConfig: SchemaConfig = {
            schemaParts: fs.readdirSync(path.resolve(this.path, 'model'))
                .map(file => fileToSchemaPartConfig(path.resolve(this.path, 'model', file)))
        };
        const dumbSchema = createSchema(schemaConfig);
        this.schema = addQueryResolvers(dumbSchema, dbAdapter);
        await dbAdapter.updateSchema(this.schema);
        this.testDataEnvironment = await initTestData(path.resolve(this.path, 'test-data.json'), this.schema);
        this._isSetUpClean = true;
    }

    async initData() {
    }

    getTestNames() {
        return fs.readdirSync(path.resolve(this.path, 'tests'))
            .filter(name => name.endsWith('.graphql'))
            .map(name => name.substr(0, name.length - '.graphql'.length));
    }

    async runTest(name: string) {
        if (!this._isSetUpClean) {
            await this.setUp();
        }

        const gqlPath = path.resolve(this.testsPath, name + '.graphql');
        const resultPath = path.resolve(this.testsPath, name + '.result.json');
        const variablesPath = path.resolve(this.testsPath, name + '.vars.json');
        let contextPath = path.resolve(this.testsPath, name + '.context.json');
        if (!fs.existsSync(contextPath)) {
            contextPath = path.resolve(this.path, 'default-context.json');
        }


        const gqlTemplate = fs.readFileSync(gqlPath, 'utf-8');
        const gqlSource = this.testDataEnvironment.fillTemplateStrings(gqlTemplate);

        const operations = parse(gqlSource).definitions
            .filter(def => def.kind == 'OperationDefinition') as OperationDefinitionNode[];
        this._isSetUpClean = this._isSetUpClean && !operations.some(op => op.operation == 'mutation');
        const hasNamedOperations = operations.length && operations[0].name;

        const expectedResultTemplate = JSON.parse(stripJsonComments(fs.readFileSync(resultPath, 'utf-8')));
        const expectedResult = this.testDataEnvironment.fillTemplateStrings(expectedResultTemplate);
        const variableValues = fs.existsSync(variablesPath) ? JSON.parse(stripJsonComments(fs.readFileSync(variablesPath, 'utf-8'))) : {};
        const context = fs.existsSync(contextPath) ? JSON.parse(stripJsonComments(fs.readFileSync(contextPath, 'utf-8'))) : {};

        let actualResult: any;
        if (hasNamedOperations) {
            const operationNames = operations.map(def => def.name!.value);
            actualResult = {};
            for (const operationName of operationNames) {
                actualResult[operationName] = await graphql(this.schema, gqlSource, {} /* root */, context, variableValues, operationName);
            }
        } else {
            actualResult = await graphql(this.schema, gqlSource, {} /* root */, context, variableValues);
        }

        if (this.options.saveActualAsExpected && !(jasmine as any).matchersUtil.equals(actualResult, expectedResult)) {
            fs.writeFileSync(resultPath, JSON.stringify(actualResult, undefined, '  '), 'utf-8');
        }

        return {
            actualResult,
            expectedResult
        };
    }
}

function fileToSchemaPartConfig(path: string): SchemaPartConfig {
    return { source: new Source(fs.readFileSync(path).toString(), path) };
}
