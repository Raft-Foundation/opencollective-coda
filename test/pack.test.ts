import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as coda from '@codahq/packs-sdk';
import {
  executeSyncFormulaFromPackDefSingleIteration,
  newJsonFetchResponse,
  newMockSyncExecutionContext,
} from '@codahq/packs-sdk/dist/development';
import { pack } from '../pack';

const API_URL = 'https://api.opencollective.com/graphql/v2';

// Fresh mock context whose single fetch returns `body`, plus a way to read the GraphQL request that was sent.
function contextReturning(body: unknown, continuation?: coda.Continuation) {
  const context = newMockSyncExecutionContext();
  context.fetcher.fetch.returns(newJsonFetchResponse(body));
  if (continuation) {
    context.sync.continuation = continuation;
  }
  const sentRequest = () => {
    const request = context.fetcher.fetch.firstCall.args[0];
    return { url: request.url, ...JSON.parse(request.body as string) };
  };
  return { context, sentRequest };
}

function runSync(name: string, params: any[], context: any) {
  return executeSyncFormulaFromPackDefSingleIteration(pack, name, params, context, {
    validateParams: true,
    validateResult: false,
  });
}

function expense(overrides: Record<string, any> = {}) {
  return {
    account: {
      slug: 'some-collective',
      name: 'Some Collective',
      transactions: { nodes: [{ type: 'DEBIT', amountInHostCurrency: { valueInCents: 1000 } }] },
      parent: { slug: 'parent', name: 'Parent' },
      host: { slug: 'raft' },
    },
    comments: { nodes: [] },
    activities: [],
    amountV2: { valueInCents: 2500, currency: 'USD' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdByAccount: { slug: 'creator', emails: ['creator@example.com'], transactions: { nodes: [] } },
    currency: 'USD',
    description: 'Office supplies',
    id: 'expense-id',
    legacyId: 42,
    payee: { slug: 'payee', emails: ['payee@example.com'], type: 'INDIVIDUAL' },
    payoutMethod: { id: 'pm', type: 'PAYPAL', name: 'PayPal' },
    status: 'PAID',
    tags: ['office'],
    type: 'INVOICE',
    virtualCard: null,
    ...overrides,
  };
}

describe('authentication', () => {
  it('requests the OAuth scopes the queries need, comma-separated', () => {
    const auth: any = pack.defaultAuthentication;
    assert.equal(auth.type, coda.AuthenticationType.OAuth2);
    // Open Collective rejects operations outside the token's scopes (default: none).
    assert.deepEqual(auth.scopes, ['email', 'expenses', 'orders', 'transactions', 'virtualCards']);
    assert.equal(auth.scopeDelimiter, ',');
  });

  it('only talks to the Open Collective API', () => {
    assert.deepEqual(pack.networkDomains, ['api.opencollective.com']);
  });
});

describe('sync table columns', () => {
  for (const table of pack.syncTables as any[]) {
    it(`${table.name} features every property so all columns are created by default`, () => {
      const properties = Object.keys(table.schema.properties);
      assert.ok(properties.length > 0);
      assert.deepEqual([...table.schema.featuredProperties].sort(), [...properties].sort());
    });
  }
});

describe('defaults', () => {
  const emptyPage = (key: string) => ({ data: { [key]: { limit: 500, offset: 0, totalCount: 0, nodes: [] } } });

  it('ExpensesToHost defaults to the raft host and a page size of 500', async () => {
    const { context, sentRequest } = contextReturning(emptyPage('expenses'));
    await runSync('ExpensesToHost', [], context);
    const { variables } = sentRequest();
    assert.deepEqual(variables.host, { slug: 'raft' });
    assert.equal(variables.limit, 500);
  });

  it('ExpensesToHost pages by 500 when more remain and no limit was given', async () => {
    const body = { data: { expenses: { limit: 500, offset: 0, totalCount: 1200, nodes: [expense()] } } };
    const { context } = contextReturning(body);
    const { continuation } = await runSync('ExpensesToHost', [], context);
    assert.deepEqual(continuation, { offset: 500 });
  });

  it('ExpensesToCollective, HostedCollectives and Transactions need no parameters', async () => {
    for (const [table, key] of [
      ['ExpensesToCollective', 'expenses'],
      ['HostedCollectives', 'accounts'],
      ['Transactions', 'transactions'],
    ]) {
      const { context, sentRequest } = contextReturning(emptyPage(key));
      await runSync(table, [], context);
      const { variables } = sentRequest();
      assert.equal(variables.limit, 500, table);
      const slug = (variables.host ?? variables.account)?.slug ?? variables.account?.[0]?.slug;
      assert.equal(slug, 'raft', table);
    }
  });

  it('prefills raft and 500 for every sync table, including those that must stay required', () => {
    for (const table of pack.syncTables as any[]) {
      const [first, limit] = table.getter.parameters;
      assert.equal(first.suggestedValue, 'raft', `${table.name} first parameter`);
      assert.equal(limit.suggestedValue, 500, `${table.name} limit`);
    }
  });
});

describe('ExpensesToHost', () => {
  const page = (nodes: any[], totalCount = nodes.length, offset = 0) => ({
    data: { expenses: { limit: 100, offset, totalCount, nodes } },
  });

  it('queries the host by slug and maps expense fields to a row', async () => {
    const { context, sentRequest } = contextReturning(page([expense()]));
    const { result } = await runSync('ExpensesToHost', ['raft', 100], context);

    const request = sentRequest();
    assert.equal(request.url, API_URL);
    assert.deepEqual(request.variables.host, { slug: 'raft' });
    assert.equal(request.variables.limit, 100);
    assert.equal(request.variables.offset, 0);
    assert.equal(request.variables.dateFrom, undefined);

    assert.equal(result.length, 1);
    const row: any = result[0];
    assert.equal(row.AccountSlug, 'some-collective');
    assert.equal(row.AccountParentSlug, 'parent');
    assert.equal(row.AccountHostSlug, 'raft');
    assert.equal(row.AmountValueInCents, 2500);
    assert.equal(row.CreatedByAccountEmail, 'creator@example.com');
    assert.equal(row.PayeeSlug, 'payee');
    assert.equal(row.PayoutMethodType, 'PAYPAL');
    assert.equal(row.Status, 'PAID');
  });

  it('tolerates optional fields being null', async () => {
    const nodes = [
      expense({
        payoutMethod: null,
        virtualCard: null,
        createdByAccount: { slug: 'creator', emails: null, transactions: { nodes: [] } },
        account: { slug: 'a', name: 'A', transactions: { nodes: [] } },
      }),
    ];
    const { context } = contextReturning(page(nodes));
    const { result } = await runSync('ExpensesToHost', ['raft', 100], context);
    const row: any = result[0];
    assert.equal(row.PayoutMethodName, null);
    assert.equal(row.CreatedByAccountEmail, null);
    assert.equal(row.AccountParentSlug, null);
    assert.equal(row.AccountHostSlug, null);
  });

  it('sends dateFrom when days is given', async () => {
    const { context, sentRequest } = contextReturning(page([]));
    await runSync('ExpensesToHost', ['raft', 100, 7], context);
    const dateFrom = sentRequest().variables.dateFrom;
    const ageInDays = (Date.now() - new Date(dateFrom).getTime()) / 86_400_000;
    assert.ok(Math.abs(ageInDays - 7) < 0.01, `dateFrom was ${dateFrom}`);
  });

  it('returns a continuation while more pages remain, and resumes from it', async () => {
    const first = contextReturning(page([expense()], 250, 0));
    const firstPage = await runSync('ExpensesToHost', ['raft', 100], first.context);
    assert.deepEqual(firstPage.continuation, { offset: 100 });

    const second = contextReturning(page([expense()], 250, 100), { offset: 100 });
    const secondPage = await runSync('ExpensesToHost', ['raft', 100], second.context);
    assert.equal(second.sentRequest().variables.offset, 100);
    assert.deepEqual(secondPage.continuation, { offset: 200 });

    const last = contextReturning(page([expense()], 250, 200), { offset: 200 });
    const lastPage = await runSync('ExpensesToHost', ['raft', 100], last.context);
    assert.equal(lastPage.continuation, undefined);
  });

  it("surfaces the API's error when a node comes back null", async () => {
    // What Open Collective returns when a field is outside the token's scopes.
    const body = {
      ...page([null]),
      errors: [{ message: 'The User Token is not allowed for operations in scope "transactions".' }],
    };
    const { context } = contextReturning(body);
    await assert.rejects(runSync('ExpensesToHost', ['raft', 100], context), (error: any) => {
      assert.match(error.message, /Open Collective returned an error/);
      assert.match(error.message, /not allowed for operations in scope "transactions"/);
      return true;
    });
  });

  it('reports when there are no error details', async () => {
    const { context } = contextReturning({ data: { expenses: null } });
    await assert.rejects(runSync('ExpensesToHost', ['raft', 100], context), /no details provided/);
  });
});

describe('error handling across sync tables', () => {
  // Each sync table reads a different root field; a null there must produce a readable error, not a TypeError.
  const cases: [string, any[], string][] = [
    ['ExpensesToHost', ['raft', 100], 'expenses'],
    ['ExpensesToCollective', ['raft', 100], 'expenses'],
    ['OrdersToHost', ['raft', 100, 1], 'accounts'],
    ['HostedCollectives', ['raft', 100], 'accounts'],
    ['UpdatesFromHostedCollectives', ['raft', 100, 7], 'updates'],
    ['Transactions', ['raft', 100], 'transactions'],
  ];
  for (const [table, params, key] of cases) {
    it(`${table} surfaces API errors when data.${key} is null`, async () => {
      const { context } = contextReturning({ data: { [key]: null }, errors: [{ message: 'boom' }] });
      await assert.rejects(runSync(table, params, context), (error: any) => {
        assert.match(error.message, /boom/);
        return true;
      });
    });
  }
});
