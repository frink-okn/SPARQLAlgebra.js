
import * as Algebra from './algebra';
import Factory from './factory';
import Util from './util';
import * as equal from 'fast-deep-equal';
import * as RDF from 'rdf-js'
import {termToString} from 'rdf-string';

const Parser = require('sparqljs').Parser;
const types = Algebra.types;

let variables = new Set<string>();
let varCount = 0;
let useQuads = false;
let factory: Factory;

/**
 * Translates the given SPARQL query to SPARQL Algebra.
 * @param sparql - Either a SPARQL string or an object generated by sparql.js
 * @param options - Optional options object. Current options:
 *                    * dataFactory: The Datafactory used to generate terms. Default @rdfjs/data-model.
 *                    * quads: Boolean indicating whether triples should be converted to Quads (consumes GRAPH statements). Default false.
 *                    * prefixes: Pre-defined prefixes for the given query. Default empty.
 *                    * baseIRI: Base IRI that should be used for the query. Default undefined (throws error if required).
 * @returns {Operation}
 */
export default function translate(sparql: any, options?:
    {
        dataFactory?: RDF.DataFactory,
        quads?: boolean,
        prefixes?: {[prefix: string]: string},
        baseIRI?: string,
        blankToVariable?: boolean
        sparqlStar?: boolean;
    }) : Algebra.Operation
{
    options = options || {};
    factory = new Factory(options.dataFactory);

    if (isString(sparql))
    {
        let parser = new Parser(options);
        // resets the identifier counter used for blank nodes
        // provides nicer and more consistent output if there are multiple calls
        parser._resetBlanks();
        sparql = parser.parse(sparql);
    }

    return translateQuery(sparql, options.quads, options.blankToVariable);
}

function translateQuery(sparql: any, quads?: boolean, blankToVariable?: boolean) : Algebra.Operation
{
    // this set is filled in during the inScopeVariables call
    variables = new Set();
    varCount = 0;
    useQuads = quads;

    if (sparql.type !== 'query' && sparql.type !== 'update')
        throw new Error('Translate only works on complete query or update objects.');

    let vars: Set<RDF.Variable> = new Set(Object.keys(inScopeVariables(sparql)).map(factory.createTerm.bind(factory)));
    let res: Algebra.Operation;

    if (sparql.type === 'query') {
        // group and where are identical, having only 1 makes parsing easier, can be undefined in DESCRIBE
        let group = { type: 'group', patterns: sparql.where || [] };
        res = translateGroupGraphPattern(group);
        res = translateAggregates(sparql, res, vars);
    }
    else if(sparql.type === 'update') {
        res = translateUpdate(sparql);
    }
    if (blankToVariable) {
        res = translateBlankNodesToVariables(res, vars);
    }

    return res;
}

function isString(str: any): boolean
{
    return typeof str === 'string';
}

function isObject(o: any): boolean
{
    return o !== null && typeof o === 'object';
}

function isVariable(term: RDF.Term) : boolean
{
    return term && term.termType === "Variable";
}

// 18.2.1
function inScopeVariables(thingy: any) : {[key: string]: boolean}
{
    let inScope: {[id:string]: boolean} = {};

    if (isVariable(thingy))
    {
        inScope[termToString(thingy)] = true;
        variables.add(thingy); // keep track of all variables so we don't generate duplicates
    }
    else if (isObject(thingy))
    {
        if (thingy.type === 'bind')
        {
            inScopeVariables(thingy.expression); // to fill `variables`
            Object.assign(inScope, inScopeVariables(thingy.variable));
        }
        else if (thingy.queryType === 'SELECT')
        {
            let all = inScopeVariables(thingy.where); // always executing this makes sure `variables` gets filled correctly
            for (let v of thingy.variables)
            {
                if (Util.isWildcard(v))
                    Object.assign(inScope, all);
                else if (v.variable) // aggregates
                    Object.assign(inScope, inScopeVariables(v.variable));
                else
                    Object.assign(inScope, inScopeVariables(v));
            }

            // TODO: I'm not 100% sure if you always add these or only when '*' was selected
            if (thingy.group)
                for (let v of thingy.group)
                    Object.assign(inScope, inScopeVariables(v));
        }
        else
            for (let key of Object.keys(thingy))
                Object.assign(inScope, inScopeVariables(thingy[key]));
    }

    return inScope;
}

function translateGroupGraphPattern(thingy: any) : Algebra.Operation
{
    // 18.2.2.1
    // already done by sparql parser

    // 18.2.2.2
    let filters: any[] = [];
    let nonfilters: any[] = [];
    if (thingy.patterns)
        for (let pattern of thingy.patterns)
            (pattern.type === 'filter' ? filters : nonfilters).push(pattern);

    // 18.2.2.3
    // 18.2.2.4
    // 18.2.2.5
    if (thingy.type === 'bgp')
        return translateBgp(thingy);

    // 18.2.2.6
    let result: Algebra.Operation;
    if (thingy.type === 'union')
        result = nonfilters.map((p: any) =>
        {
            // sparqljs doesn't always indicate the children are groups
            if (p.type !== 'group')
                p = { type: 'group', patterns: [p] };
            return translateGroupGraphPattern(p);
        }).reduce((acc: Algebra.Operation, item: Algebra.Operation) => factory.createUnion(acc, item));
    else if (thingy.type === 'graph')
        // need to handle this separately since the filters need to be in the graph
        return translateGraph(thingy);
    else if (thingy.type === 'group')
        result = nonfilters.reduce(accumulateGroupGraphPattern, factory.createBgp([]));
    // custom values operation
    else if (thingy.type === 'values')
        result = translateInlineData(thingy);
    else if (thingy.type === 'query')
        result = translateQuery(thingy, useQuads, false);
    else
        throw new Error('Unexpected type: ' + thingy.type);


    if (filters.length > 0)
    {
        let expressions: Algebra.Expression[] = filters.map(filter => translateExpression(filter.expression));
        if (expressions.length > 0)
            result = factory.createFilter(result, expressions.reduce((acc, exp) => factory.createOperatorExpression('&&', [acc, exp])));
    }

    return result;
}

function translateExpression(exp: any) : Algebra.Expression
{
    if (Util.isTerm(exp) || exp.termType === 'Quad')
        return factory.createTermExpression(exp);
    if (Util.isWildcard(exp))
        return factory.createWildcardExpression();
    if (exp.aggregation)
        return factory.createAggregateExpression(exp.aggregation, translateExpression(exp.expression), exp.distinct, exp.separator);
    if (exp.function)
        return factory.createNamedExpression(<RDF.NamedNode> exp.function, exp.args.map(translateExpression));
    if (exp.operator)
    {
        if (exp.operator === 'exists' || exp.operator === 'notexists')
            return factory.createExistenceExpression(exp.operator === 'notexists', translateGroupGraphPattern(exp.args[0]));
        if (exp.operator === 'in' || exp.operator === 'notin')
            exp.args = [exp.args[0]].concat(exp.args[1]); // sparql.js uses 2 arguments with the second one being a list
        return factory.createOperatorExpression(exp.operator, exp.args.map(translateExpression));
    }
    throw new Error('Unknown expression: ' + JSON.stringify(exp));
}

function translateBgp(thingy: any) : Algebra.Operation
{
    let patterns: Algebra.Pattern[] = [];
    let joins: Algebra.Operation[] = [];
    for (let t of thingy.triples)
    {
        if (t.predicate.type === 'path')
        {
            // translatePath returns a mix of Quads and Paths
            let path = translatePath(t);
            for (let p of path)
            {
                if (p.type === types.PATH)
                {
                    if (patterns.length > 0)
                        joins.push(factory.createBgp(patterns));
                    patterns = [];
                    joins.push(p);
                }
                else
                    patterns.push(<Algebra.Pattern>p);
            }
        }
        else
            patterns.push(translateQuad(t));
    }
    if (patterns.length > 0)
        joins.push(factory.createBgp(patterns));
    if (joins.length === 1)
        return joins[0];
    return joins.reduce((acc, item) => factory.createJoin(acc, item));
}

function translatePath(triple: any) : Algebra.Operation[]
{
    let sub = triple.subject;
    let pred = translatePathPredicate(triple.predicate);
    let obj = triple.object;

    return simplifyPath(<RDF.Quad_Subject> sub, pred, <RDF.Quad_Object> obj);
}

function translatePathPredicate(predicate: any) : Algebra.Operation
{
    if (Util.isTerm(predicate) && predicate.termType === "NamedNode")
        return factory.createLink(predicate);

    if (predicate.pathType === '^')
        return factory.createInv(translatePathPredicate(predicate.items[0]));

    if (predicate.pathType === '!')
    {
        // negation is either over a single predicate or a list of disjuncted properties
        let normals: RDF.NamedNode[] = [];
        let inverted: RDF.NamedNode[] = [];
        let items;
        if (predicate.items[0].type === 'path' && predicate.items[0].pathType === '|')
            items = predicate.items[0].items; // the | element
        else
            items = predicate.items;

        for (let item of items)
        {
            if (Util.isTerm(item))
                normals.push(item);
            else if (item.pathType === '^')
                inverted.push(item.items[0]);
            else
                throw new Error('Unexpected item: ' + JSON.stringify(item));
        }

        // NPS elements do not have the LINK function
        let normalElement = factory.createNps(normals);
        let invertedElement = factory.createInv(factory.createNps(inverted));

        if (inverted.length === 0)
            return normalElement;
        if (normals.length === 0)
            return invertedElement;
        return factory.createAlt(normalElement, invertedElement);
    }

    if (predicate.pathType === '/')
        return predicate.items.map(translatePathPredicate).reduce((acc: Algebra.Operation, p: Algebra.Operation) => factory.createSeq(acc, p));
    if (predicate.pathType === '|')
        return predicate.items.map(translatePathPredicate).reduce((acc: Algebra.Operation, p: Algebra.Operation) => factory.createAlt(acc, p));
    if (predicate.pathType === '*')
        return factory.createZeroOrMorePath(translatePathPredicate(predicate.items[0]));
    if (predicate.pathType === '+')
        return factory.createOneOrMorePath(translatePathPredicate(predicate.items[0]));
    if (predicate.pathType === '?')
        return factory.createZeroOrOnePath(translatePathPredicate(predicate.items[0]));

    throw new Error('Unable to translate path expression ' + JSON.stringify(predicate));
}

function simplifyPath(subject: RDF.Quad_Subject, predicate: Algebra.Operation, object: RDF.Quad_Object) : Algebra.Operation[]
{
    if (predicate.type === types.LINK)
        return [factory.createPattern(subject, (<Algebra.Link>predicate).iri, object)];

    if (predicate.type === types.INV)
        return simplifyPath(<RDF.Quad_Subject> object, (<Algebra.Inv>predicate).path, subject);

    if (predicate.type === types.SEQ)
    {
        let v = generateFreshVar();
        let left = simplifyPath(subject, (<Algebra.Seq>predicate).left, v);
        let right = simplifyPath(v, (<Algebra.Seq>predicate).right, object);
        return left.concat(right);
    }

    return [ factory.createPath(subject, predicate, object) ];
}

function generateFreshVar() : RDF.Variable
{
    let v: string = '?var' + varCount++;
    if (variables.has(v))
        return generateFreshVar();
    variables.add(v);
    return <RDF.Variable>factory.createTerm(v);
}

function translateQuad(quad: RDF.BaseQuad) : Algebra.Pattern
{
    return factory.createPattern(quad.subject, quad.predicate, quad.object, quad.graph);
}

function translateGraph(graph: any) : Algebra.Operation
{
    graph.type = 'group';
    let result = translateGroupGraphPattern(graph);
    if (useQuads)
        result = recurseGraph(result, graph.name);
    else
        result = factory.createGraph(result, graph.name);

    return result;
}

let typeVals = Object.keys(types).map(key => (<any>types)[key]);
function recurseGraph(thingy: Algebra.Operation, graph: RDF.Term, replacement?: RDF.Variable) : Algebra.Operation
{
    if (thingy.type === types.BGP)
        (<Algebra.Bgp>thingy).patterns = (<Algebra.Bgp>thingy).patterns.map(quad =>
        {
            if (replacement)
            {
                if (quad.subject.equals(graph)) quad.subject = replacement;
                if (quad.predicate.equals(graph)) quad.predicate = replacement;
                if (quad.object.equals(graph)) quad.object = replacement;
            }
            quad.graph = graph;
            return quad;
        });
    else if (thingy.type === types.PATH)
    {
        const p = <Algebra.Path> thingy;
        if (replacement)
        {
            if (p.subject.equals(graph)) p.subject = replacement;
            if (p.object.equals(graph))  p.object = replacement;
        }
        thingy.graph = graph;
    }
    // need to replace variables in subqueries should the graph also be a variable of the same name
    // unless the subquery projects that variable
    else if (thingy.type === types.PROJECT && !replacement)
    {
        const proj = <Algebra.Project> thingy;
        if (!proj.variables.some(v => v.equals(graph)))
            replacement = generateFreshVar();
        proj.input = recurseGraph(proj.input, graph, replacement);
    }
    // this can happen if the query extends an expression to the name of the graph
    // since the extend happens here there should be no further occurrences of this name
    // if there are it's the same situation as above
    else if (thingy.type === types.EXTEND && !replacement)
    {
        const ext = <Algebra.Extend> thingy;
        if (ext.variable.equals(graph))
            replacement = generateFreshVar();
        ext.input = recurseGraph(ext.input, graph, replacement);
    }
    else
    {
        for (let key of Object.keys(thingy))
        {
            if (Array.isArray(thingy[key]))
                thingy[key] = thingy[key].map((x: any) => recurseGraph(x, graph, replacement));
            else if (typeVals.indexOf(thingy[key].type) >= 0) // can't do instanceof on an interface
                thingy[key] = recurseGraph(thingy[key], graph, replacement);
            else if (replacement && isVariable(thingy[key]) && thingy[key].equals(graph))
                thingy[key] = replacement;
        }
    }

    return thingy;
}

function accumulateGroupGraphPattern(G: Algebra.Operation, E: any) : Algebra.Operation
{
    if (E.type === 'optional')
    {
        // optional input needs to be interpreted as a group
        let A: Algebra.Operation = translateGroupGraphPattern({ type: 'group', patterns: E.patterns });
        if (A.type === types.FILTER)
        {
            let filter = <Algebra.Filter> A;
            G = factory.createLeftJoin(G, filter.input, filter.expression);
        }
        else
            G = factory.createLeftJoin(G, A);
    }
    else if (E.type === 'minus')
    {
        // minus input needs to be interpreted as a group
        let A: Algebra.Operation = translateGroupGraphPattern({ type: 'group', patterns: E.patterns });
        G = factory.createMinus(G, A);
    }
    else if (E.type === 'bind')
        G = factory.createExtend(G, <RDF.Variable>E.variable, translateExpression(E.expression));
    else if (E.type === 'service')
    {
        // transform to group so childnodes get parsed correctly
        E.type = 'group';
        let A = factory.createService(translateGroupGraphPattern(E), E.name, E.silent);
        G = simplifiedJoin(G, A);
    }
    else
    {
        let A = translateGroupGraphPattern(E);
        G = simplifiedJoin(G, A);
    }

    return G;
}

function simplifiedJoin(G: Algebra.Operation, A: Algebra.Operation): Algebra.Operation
{
    // Note: this is more simplification than requested in 18.2.2.8, but no reason not to do it.
    if (G.type  === types.BGP && A.type === types.BGP)
        G = factory.createBgp([].concat(G.patterns, A.patterns));
    // 18.2.2.8 (simplification)
    else if (G.type === types.BGP && (<Algebra.Bgp>G).patterns.length === 0)
        G = A;
    else if (A.type === types.BGP && (<Algebra.Bgp>A).patterns.length === 0)
    {} // do nothing
    else
        G = factory.createJoin(G, A);
    return G;
}

function translateInlineData(values: any) : Algebra.Values
{
    let variables = <RDF.Variable[]>(values.values.length === 0 ? [] : Object.keys(values.values[0])).map(factory.createTerm.bind(factory));
    let bindings = values.values.map((binding: any) =>
    {
        let keys = Object.keys(binding);
        keys = keys.filter(k => binding[k] !== undefined);
        let map: any = {};
        for (let key of keys)
            map[key] = binding[key];
        return map;
    });
    return factory.createValues(variables, bindings);
}

// --------------------------------------- AGGREGATES
function translateAggregates(query: any, res: Algebra.Operation, variables: Set<RDF.Variable>) : Algebra.Operation
{
    // 18.2.4.1
    let E = [];

    let A: any = {};
    query.variables = mapAggregates(query.variables, A);
    query.having = mapAggregates(query.having, A);
    query.order = mapAggregates(query.order, A);

    // if there are any aggregates or if we have a groupBy (both result in a GROUP)
    if (query.group || Object.keys(A).length > 0)
    {
        let aggregates = Object.keys(A).map(v => translateBoundAggregate(A[v], <RDF.Variable>factory.createTerm(v)));
        let vars: RDF.Variable[] = [];
        if (query.group)
        {
            for (let e of query.group)
            {
                if (e.expression.type)
                {
                    const v = e.variable ? <RDF.Variable>e.variable : generateFreshVar();
                    res = factory.createExtend(res, v, translateExpression(e.expression));
                    vars.push(v);
                }
                else
                    vars.push(<RDF.Variable>e.expression); // this will always be a var, otherwise sparql would be invalid
            }
        }
        res = factory.createGroup(res, vars, aggregates);
    }

    // 18.2.4.2
    if (query.having)
        for (let filter of query.having)
            res = factory.createFilter(res, translateExpression(filter));

    // 18.2.4.3
    if (query.values)
        res = factory.createJoin(res, translateInlineData(query));

    // 18.2.4.4
    let PV = new Set<RDF.Term>();

    if (query.queryType === 'SELECT' || query.queryType === 'DESCRIBE')
    {
        if (query.variables.some((e: any) => e && Util.isWildcard(e)))
            PV = variables;
        else
        {
            for (let v of query.variables)
            {
                // can have non-variables with DESCRIBE
                if (isVariable(v) || !v.variable)
                    PV.add(v);
                else if (v.variable) // ... AS ?x
                {
                    PV.add(v.variable);
                    E.push(v);
                }
            }
        }
    }

    // TODO: Jena simplifies by having a list of extends
    for (let v of E)
        res = factory.createExtend(res, <RDF.Variable>v.variable, translateExpression(v.expression));

    // 18.2.5
    // not using toList and toMultiset

    // 18.2.5.1
    if (query.order)
        res = factory.createOrderBy(res, query.order.map((exp: any) =>
        {
            let result = translateExpression(exp.expression);
            if (exp.descending)
                result = factory.createOperatorExpression(types.DESC, [result]); // TODO: should this really be an expression?
            return result;
        }));

    // 18.2.5.2
    // construct does not need a project (select, ask and describe do)
    if (query.queryType === 'SELECT')
        res = factory.createProject(res, <RDF.Variable[]> Array.from(PV));

    // 18.2.5.3
    if (query.distinct)
        res = factory.createDistinct(res);

    // 18.2.5.4
    if (query.reduced)
        res = factory.createReduced(res);

    // NEW: support for ask/construct/describe queries
    if (query.queryType === 'CONSTRUCT')
        res = factory.createConstruct(res, query.template.map(translateQuad));
    else if (query.queryType === 'ASK')
        res = factory.createAsk(res);
    else if (query.queryType === 'DESCRIBE')
        res = factory.createDescribe(res, Array.from(PV));

    // Slicing needs to happen after construct/describe
    // 18.2.5.5
    if (query.offset || query.limit)
        res = factory.createSlice(res, query.offset, query.limit);

    if (query.from)
        res = factory.createFrom(res, query.from.default, query.from.named);

    return res;
}

// rewrites some of the input sparql object to make use of aggregate variables
function mapAggregates (thingy: any, aggregates: {[key: string]: any}) : any
{
    if (!thingy)
        return thingy;

    if (thingy.type === 'aggregate')
    {
        let found = false;
        let v;
        for (let key of Object.keys(aggregates))
        {
            if (equal(aggregates[key], thingy))
            {
                v = factory.createTerm(key);
                found = true;
                break;
            }
        }
        if (!found)
        {
            v = generateFreshVar();
            aggregates[termToString(v)] = thingy;
        }
        return v;
    }

    // non-aggregate expression
    if (thingy.expression)
        thingy.expression = mapAggregates(thingy.expression, aggregates);
    else if (thingy.args)
        mapAggregates(thingy.args, aggregates);
    else if (Array.isArray(thingy))
        thingy.forEach((subthingy, idx) => thingy[idx] = mapAggregates(subthingy, aggregates));

    return thingy;
}

function translateBoundAggregate (thingy: any, v: RDF.Variable) : Algebra.BoundAggregate
{
    if (thingy.type !== 'aggregate' || !thingy.aggregation)
        throw new Error('Unexpected input: ' + JSON.stringify(thingy));

    let A  = <Algebra.BoundAggregate>translateExpression(thingy);
    A.variable = v;

    return A;
}

function translateUpdate (thingy: any) : Algebra.Operation {
    if (thingy.updates.length === 1)
        return translateSingleUpdate(thingy.updates[0]);
    return factory.createCompositeUpdate(thingy.updates.map(translateSingleUpdate));
}

function translateSingleUpdate (thingy: any) : Algebra.Update {
    if (thingy.updateType === 'insertdelete' || thingy.updateType === 'deletewhere' || thingy.updateType === 'delete' || thingy.updateType === 'insert')
        return translateInsertDelete(thingy);
    if (thingy.type === 'load')
        return translateUpdateGraphLoad(thingy);
    if (thingy.type === 'clear' || thingy.type === 'create' || thingy.type === 'drop')
        return translateUpdateGraph(thingy);
    if (thingy.type === 'add' || thingy.type === 'copy' || thingy.type === 'move')
        return translateUpdateGraphShortcut(thingy);

    throw new Error(`Unknown update type ${thingy.updateType}`);
}

type insertDeleteInput = {
    updateType: 'insertdelete' | 'deletewhere' | 'delete' | 'insert';
    delete?: any[];
    insert?: any[];
    where?: any[];
    graph?: RDF.NamedNode;
    using?: { default: RDF.NamedNode[]; named: RDF.NamedNode[] };
};
function translateInsertDelete (thingy: insertDeleteInput): Algebra.Update
{
    if (!useQuads)
        throw new Error('INSERT/DELETE operations are only supported with quads option enabled');

    let deleteTriples: Algebra.Pattern[] = [];
    let insertTriples: Algebra.Pattern[] = [];
    let where: Algebra.Operation;
    if (thingy.delete)
        deleteTriples = Util.flatten(thingy.delete.map(input => translateUpdateTriplesBlock(input, thingy.graph)));
    if (thingy.insert)
        insertTriples = Util.flatten(thingy.insert.map(input => translateUpdateTriplesBlock(input, thingy.graph)));
    if (thingy.where && thingy.where.length > 0) {
        where = translateGroupGraphPattern({ type: 'group', patterns: thingy.where });
        if (thingy.using)
            where = factory.createFrom(where, thingy.using.default, thingy.using.named);
        else if (thingy.graph)
            // this is equivalent
            where = factory.createFrom(where, [thingy.graph], []);
    } else if (thingy.updateType === 'deletewhere' && deleteTriples.length > 0) {
        where = factory.createBgp(deleteTriples);
    }

    return factory.createDeleteInsert(
        deleteTriples.length > 0 ? deleteTriples : undefined,
        insertTriples.length > 0 ? insertTriples : undefined,
        where,
    );
}

type updateTriplesBlockInput = {
    type: 'graph' | 'bgp';
    triples: RDF.BaseQuad[];
    name?: RDF.NamedNode
};
// for now, UPDATE parsing will always return quads and have no GRAPH elements
function translateUpdateTriplesBlock (thingy: updateTriplesBlockInput, graph?: RDF.NamedNode): Algebra.Pattern[] {
    let currentGraph = graph;
    if (thingy.type === 'graph')
        currentGraph = thingy.name;
    let currentTriples = thingy.triples;
    if (currentGraph)
        currentTriples = currentTriples.map(triple => Object.assign(triple, { graph: currentGraph }));
    return currentTriples.map(translateQuad);
}

type updateGraphInput = {
    type: 'clear' | 'create' | 'drop';
    silent: boolean,
    graph: { all?: boolean; default?: boolean; named?: boolean; name?: RDF.NamedNode };
};
function translateUpdateGraph (thingy: updateGraphInput): Algebra.UpdateGraph
{
    let source: 'DEFAULT' | 'NAMED' | 'ALL' | RDF.NamedNode;
    if (thingy.graph.all)
        source = 'ALL';
    else if (thingy.graph.default)
        source = 'DEFAULT';
    else if (thingy.graph.named)
        source = 'NAMED';
    else
        source = thingy.graph.name;

    switch (thingy.type)
    {
        case 'clear': return factory.createClear(source, thingy.silent);
        case 'create': return factory.createCreate(source as RDF.NamedNode, thingy.silent);
        case 'drop':  return factory.createDrop(source, thingy.silent);
    }
}

type updateGraphLoadInput = {
    type: 'load';
    silent: boolean,
    source: RDF.NamedNode;
    destination?: RDF.NamedNode;
};
function translateUpdateGraphLoad (thingy: updateGraphLoadInput): Algebra.Load
{
    return factory.createLoad(thingy.source, thingy.destination, thingy.silent);
}

type updateGraphShortcutInput = {
    type: 'copy' | 'move' | 'add';
    silent: boolean;
    source: { type: 'graph'; default?: boolean; name?: RDF.NamedNode };
    destination: { default?: boolean; name?: RDF.NamedNode };
};
function translateUpdateGraphShortcut (thingy: updateGraphShortcutInput): Algebra.UpdateGraphShortcut
{
    const source = thingy.source.default ? 'DEFAULT' : thingy.source.name;
    const destination = thingy.destination.default ? 'DEFAULT' : thingy.destination.name;
    switch (thingy.type)
    {
        case 'copy': return factory.createCopy(source, destination, thingy.silent);
        case 'move': return factory.createMove(source, destination, thingy.silent);
        case 'add':  return factory.createAdd(source, destination, thingy.silent);
    }
}

function translateBlankNodesToVariables (res: Algebra.Operation, variables: Set<RDF.Variable>) : Algebra.Operation
{
    const blankToVariableMapping: {[bLabel: string]: RDF.Variable} = {};
    const variablesRaw: {[vLabel: string]: boolean} = Array.from(variables).reduce((acc: {[vLabel: string]: boolean}, variable: RDF.Variable) => {
        acc[variable.value] = true;
        return acc;
    }, {});
    return Util.mapOperation(res, {
        'path': (op: Algebra.Path, factory: Factory) => {
            return {
                result: factory.createPath(
                    blankToVariable(op.subject),
                    op.predicate,
                    blankToVariable(op.object),
                    blankToVariable(op.graph),
                ),
                recurse: false,
            };
        },
        'pattern': (op: Algebra.Pattern, factory: Factory) => {
            return {
                result: factory.createPattern(
                    blankToVariable(op.subject),
                    blankToVariable(op.predicate),
                    blankToVariable(op.object),
                    blankToVariable(op.graph),
                ),
                recurse: false,
            };
        },
        'construct': (op: Algebra.Construct) => {
            // Blank nodes in CONSTRUCT templates must be maintained
            return {
                result: factory.createConstruct(translateBlankNodesToVariables(op.input, variables), op.template),
                recurse: false,
            };
        },
    });

  function blankToVariable(term: RDF.Term): RDF.Term
  {
      if (term.termType === 'BlankNode') {
          let variable = blankToVariableMapping[term.value];
          if (!variable) {
              variable = Util.createUniqueVariable(term.value, variablesRaw, factory.dataFactory);
              variablesRaw[variable.value] = true;
              blankToVariableMapping[term.value] = variable;
          }
          return variable;
      }
      return term;
  }
}
