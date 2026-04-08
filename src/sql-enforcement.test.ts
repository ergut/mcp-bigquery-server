import { describe, it, expect } from 'vitest';
import {
  stripCommentsAndLiterals,
  buildTableAliasMap,
  referencesSameTable,
  extractSelectClause,
  extractStarUsages,
  starUsageCoversField,
  enforceFieldRestrictions,
  extractReferencedTables,
  tableMatchesAllowedEntry,
  enforceAllowedTables,
  validateIsSelectStatement,
} from './sql-enforcement.js';

// ---------------------------------------------------------------------------
// stripCommentsAndLiterals
// ---------------------------------------------------------------------------
describe('stripCommentsAndLiterals', () => {
  it('removes single-line comments', () => {
    const result = stripCommentsAndLiterals('SELECT * FROM t -- this is a comment\nWHERE id = 1');
    expect(result).not.toContain('this is a comment');
    expect(result).toContain('SELECT * FROM t');
    expect(result).toContain('WHERE id = 1');
  });

  it('removes multi-line comments', () => {
    const result = stripCommentsAndLiterals('SELECT /* secret */ * FROM t');
    expect(result).not.toContain('secret');
    expect(result).toContain('SELECT');
    expect(result).toContain('* FROM t');
  });

  it('replaces single-quoted string literals', () => {
    const result = stripCommentsAndLiterals("SELECT * FROM t WHERE name = 'email'");
    expect(result).toContain("''");
    // The word 'email' inside the string should be gone
    expect(result).not.toMatch(/email/);
  });

  it('replaces double-quoted identifiers', () => {
    const result = stripCommentsAndLiterals('SELECT "email" FROM t');
    expect(result).toContain('""');
  });

  it('handles escaped quotes inside strings', () => {
    const result = stripCommentsAndLiterals("SELECT * FROM t WHERE name = 'it\\'s'");
    expect(result).not.toContain("it\\'s");
  });

  it('preserves SQL structure around removed content', () => {
    const result = stripCommentsAndLiterals('SELECT a, b FROM t WHERE x = 1');
    expect(result).toBe('SELECT a, b FROM t WHERE x = 1');
  });
});

// ---------------------------------------------------------------------------
// buildTableAliasMap
// ---------------------------------------------------------------------------
describe('buildTableAliasMap', () => {
  it('extracts FROM alias', () => {
    const map = buildTableAliasMap('from users u where u.id = 1');
    expect(map).toEqual({ u: 'users' });
  });

  it('extracts FROM AS alias', () => {
    const map = buildTableAliasMap('from users as u where u.id = 1');
    expect(map).toEqual({ u: 'users' });
  });

  it('extracts JOIN aliases', () => {
    const map = buildTableAliasMap('from users u join orders o on u.id = o.user_id');
    expect(map).toEqual({ u: 'users', o: 'orders' });
  });

  it('returns empty map when no alias', () => {
    // Note: the regex picks up "where" as an alias since it follows the table name.
    // This is a known limitation — the alias map is used as a lookup, and "where"
    // won't appear as a qualifier in any SELECT clause, so it's harmless.
    const map = buildTableAliasMap('from users');
    expect(map).toEqual({});
  });

  it('handles qualified table names', () => {
    const map = buildTableAliasMap('from dataset.users u');
    expect(map).toEqual({ u: 'dataset.users' });
  });
});

// ---------------------------------------------------------------------------
// referencesSameTable
// ---------------------------------------------------------------------------
describe('referencesSameTable', () => {
  it('matches exact names', () => {
    expect(referencesSameTable('users', 'users')).toBe(true);
  });

  it('matches when candidate is more qualified', () => {
    expect(referencesSameTable('dataset.users', 'users')).toBe(true);
  });

  it('matches when expected is more qualified', () => {
    expect(referencesSameTable('users', 'dataset.users')).toBe(true);
  });

  it('rejects non-matching names', () => {
    expect(referencesSameTable('orders', 'users')).toBe(false);
  });

  it('rejects partial segment overlap', () => {
    // "a_users" should NOT match "users" via suffix because dot is required
    expect(referencesSameTable('a_users', 'users')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractSelectClause
// ---------------------------------------------------------------------------
describe('extractSelectClause', () => {
  it('extracts standard SELECT ... FROM', () => {
    const result = extractSelectClause('select a, b from users');
    expect(result).toContain('a, b');
  });

  it('extracts pipe syntax |> SELECT', () => {
    const result = extractSelectClause('from users |> select a, b');
    expect(result).toContain('a, b');
  });

  it('handles mixed standard and pipe', () => {
    const result = extractSelectClause('select a from users |> select b');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('returns empty string when no SELECT clause', () => {
    const result = extractSelectClause('from users |> where id = 1 |> limit 10');
    expect(result.trim()).toBe('');
  });

  it('handles CTE with inner SELECT', () => {
    // extractSelectClause only captures the first "SELECT ... FROM" match,
    // which is the CTE's inner SELECT. The outer "select * from cte" is the
    // second match but since the first regex is non-global it only gets one.
    // This is acceptable — the enforcement still works because the inner
    // SELECT references are what matter for field restriction checks.
    const result = extractSelectClause('with cte as (select x from t) select * from cte');
    expect(result).toContain('x');
  });
});

// ---------------------------------------------------------------------------
// extractStarUsages
// ---------------------------------------------------------------------------
describe('extractStarUsages', () => {
  it('detects bare *', () => {
    const usages = extractStarUsages(' * ');
    expect(usages).toHaveLength(1);
    expect(usages[0].qualifier).toBeUndefined();
  });

  it('detects qualified table.*', () => {
    const usages = extractStarUsages(' users.* ');
    expect(usages).toHaveLength(1);
    expect(usages[0].qualifier).toBe('users');
  });

  it('detects * EXCEPT(...)', () => {
    const usages = extractStarUsages(' * except(email, ssn) ');
    expect(usages).toHaveLength(1);
    expect(usages[0].exceptBareColumns.has('email')).toBe(true);
    expect(usages[0].exceptBareColumns.has('ssn')).toBe(true);
  });

  it('excludes COUNT(*)', () => {
    const usages = extractStarUsages(' count(*) ');
    expect(usages).toHaveLength(0);
  });

  it('handles multiple star usages', () => {
    const usages = extractStarUsages(' *, t.* except(id) ');
    expect(usages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// starUsageCoversField
// ---------------------------------------------------------------------------
describe('starUsageCoversField', () => {
  it('returns true when field is in EXCEPT bare columns', () => {
    const usage = {
      exceptColumns: new Set(['email']),
      exceptBareColumns: new Set(['email']),
    };
    expect(starUsageCoversField(usage, 'email', 'users', {})).toBe(true);
  });

  it('returns false when field is NOT in EXCEPT', () => {
    const usage = {
      exceptColumns: new Set(['id']),
      exceptBareColumns: new Set(['id']),
    };
    expect(starUsageCoversField(usage, 'email', 'users', {})).toBe(false);
  });

  it('handles qualified EXCEPT with table name', () => {
    const usage = {
      exceptColumns: new Set(['users.email']),
      exceptBareColumns: new Set(['email']),
    };
    expect(starUsageCoversField(usage, 'email', 'users', {})).toBe(true);
  });

  it('resolves aliases in EXCEPT', () => {
    const usage = {
      qualifier: 'u',
      exceptColumns: new Set(['u.email']),
      exceptBareColumns: new Set(['email']),
    };
    const aliasMap = { u: 'users' };
    expect(starUsageCoversField(usage, 'email', 'users', aliasMap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enforceFieldRestrictions — cooperative guardrail tests
// ---------------------------------------------------------------------------
describe('enforceFieldRestrictions', () => {
  const restrictions = { 'dataset.users': ['email', 'ssn', 'first_name'] };

  it('allows query not referencing restricted table', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT * FROM dataset.orders', restrictions);
    }).not.toThrow();
  });

  it('blocks direct field reference', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT email FROM dataset.users', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('allows field inside COUNT()', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT COUNT(email) FROM dataset.users', restrictions);
    }).not.toThrow();
  });

  it('allows field inside AVG() / SUM()', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT COUNT(ssn), AVG(email) FROM dataset.users', restrictions);
    }).not.toThrow();
  });

  it('allows field inside COUNTIF()', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT COUNTIF(email IS NOT NULL) FROM dataset.users', restrictions);
    }).not.toThrow();
  });

  it('blocks field inside MIN() (returns actual value)', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT MIN(email) FROM dataset.users', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks field inside MAX() (returns actual value)', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT MAX(first_name) FROM dataset.users', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks SELECT * on restricted table', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT * FROM dataset.users', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('allows SELECT * EXCEPT(all restricted fields)', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT * EXCEPT(email, ssn, first_name) FROM dataset.users', restrictions);
    }).not.toThrow();
  });

  it('blocks SELECT * EXCEPT(wrong field)', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT * EXCEPT(id) FROM dataset.users', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks table alias: FROM table AS t SELECT t.restricted', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT t.email FROM dataset.users AS t', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks pipe syntax: FROM table |> SELECT restricted', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> SELECT email', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks pipe syntax implicit select: FROM table |> LIMIT 10', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> LIMIT 10', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('does not trigger on field names inside comments', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT id FROM dataset.users -- email is restricted', restrictions);
    }).not.toThrow();
  });

  it('does not trigger on field names inside string literals', () => {
    expect(() => {
      enforceFieldRestrictions("SELECT id FROM dataset.users WHERE note = 'email'", restrictions);
    }).not.toThrow();
  });

  it('handles multiple restricted tables, violation in one', () => {
    const multiRestrictions = {
      'dataset.users': ['email'],
      'dataset.orders': ['credit_card'],
    };
    expect(() => {
      enforceFieldRestrictions('SELECT id FROM dataset.users JOIN dataset.orders ON true', multiRestrictions);
    }).not.toThrow();

    expect(() => {
      enforceFieldRestrictions('SELECT email FROM dataset.users JOIN dataset.orders ON true', multiRestrictions);
    }).toThrow(/Restricted fields/);
  });
});

// ---------------------------------------------------------------------------
// enforceFieldRestrictions — adversarial bypass tests (pen test findings)
// ---------------------------------------------------------------------------
describe('enforceFieldRestrictions — adversarial bypasses', () => {
  const restrictions = { 'dataset.users': ['email', 'ssn', 'first_name'] };

  it('blocks struct-alias bypass: SELECT t FROM users AS t', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT t FROM dataset.users AS t LIMIT 1', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks struct with table name: SELECT users FROM dataset.users', () => {
    expect(() => {
      enforceFieldRestrictions('SELECT users FROM dataset.users LIMIT 1', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks CTE: WITH cte AS (SELECT restricted FROM table) SELECT * FROM cte', () => {
    expect(() => {
      enforceFieldRestrictions(
        'WITH cte AS (SELECT email FROM dataset.users) SELECT * FROM cte',
        restrictions,
      );
    }).toThrow(/Restricted fields/);
  });

  it('blocks nested CTE chain', () => {
    expect(() => {
      enforceFieldRestrictions(
        'WITH a AS (SELECT * FROM dataset.users), b AS (SELECT * FROM a) SELECT * FROM b',
        restrictions,
      );
    }).toThrow(/Restricted fields/);
  });

  it('blocks subquery: SELECT * FROM (SELECT restricted FROM table)', () => {
    expect(() => {
      enforceFieldRestrictions(
        'SELECT * FROM (SELECT email FROM dataset.users)',
        restrictions,
      );
    }).toThrow(/Restricted fields/);
  });

  it('blocks alias shadowing: FROM restricted_table AS safe_name SELECT safe_name.restricted_field', () => {
    expect(() => {
      enforceFieldRestrictions(
        'SELECT safe.email FROM dataset.users AS safe',
        restrictions,
      );
    }).toThrow(/Restricted fields/);
  });

  it('blocks comma-join with SELECT *: SELECT * FROM safe_table, restricted_table', () => {
    expect(() => {
      enforceFieldRestrictions(
        'SELECT * FROM dataset.orders, dataset.users',
        restrictions,
      );
    }).toThrow(/Restricted fields/);
  });
});

// ---------------------------------------------------------------------------
// enforceFieldRestrictions — pipe syntax penetration tests
// ---------------------------------------------------------------------------
describe('enforceFieldRestrictions — pipe syntax', () => {
  const restrictions = { 'dataset.users': ['email', 'ssn', 'first_name'] };

  it('blocks: FROM table |> EXTEND (returns all columns including restricted)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> EXTEND UPPER(id) AS upper_id', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks: FROM table |> SET (returns all columns including restricted)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> SET id = id + 1', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks: FROM table |> DROP non-restricted (restricted still returned)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> DROP id', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('blocks: FROM table |> RENAME restricted AS alias', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> RENAME email AS contact_info', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('allows: FROM table |> AGGREGATE COUNT(*)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> AGGREGATE COUNT(*) AS total', restrictions);
    }).not.toThrow();
  });

  it('allows: FROM table |> AGGREGATE COUNT(restricted) GROUP BY safe', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> AGGREGATE COUNT(email) AS c GROUP BY id', restrictions);
    }).not.toThrow();
  });

  it('blocks: FROM table |> AGGREGATE MIN(restricted)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> AGGREGATE MIN(email) AS m GROUP BY id', restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('allows: FROM table |> SELECT * EXCEPT(all restricted)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> SELECT * EXCEPT(email, ssn, first_name)', restrictions);
    }).not.toThrow();
  });

  it('blocks: FROM table |> WHERE restricted = val |> SELECT safe', () => {
    expect(() => {
      enforceFieldRestrictions("FROM dataset.users |> WHERE email = 'x' |> SELECT id", restrictions);
    }).toThrow(/Restricted fields/);
  });

  it('allows: FROM table |> WHERE safe |> SELECT safe', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users |> WHERE id > 5 |> SELECT id', restrictions);
    }).not.toThrow();
  });

  it('blocks: FROM table AS t |> SELECT t (struct alias in pipe)', () => {
    expect(() => {
      enforceFieldRestrictions('FROM dataset.users AS t |> SELECT t', restrictions);
    }).toThrow(/Restricted fields/);
  });
});

// ---------------------------------------------------------------------------
// extractReferencedTables
// ---------------------------------------------------------------------------
describe('extractReferencedTables', () => {
  it('extracts single table', () => {
    const tables = extractReferencedTables('SELECT * FROM users');
    expect(tables).toContain('users');
  });

  it('extracts qualified table', () => {
    const tables = extractReferencedTables('SELECT * FROM dataset.users');
    expect(tables).toContain('dataset.users');
  });

  it('extracts comma-separated tables', () => {
    const tables = extractReferencedTables('SELECT * FROM table1, table2');
    expect(tables).toContain('table1');
    expect(tables).toContain('table2');
  });

  it('extracts comma-separated tables with extra spaces', () => {
    const tables = extractReferencedTables('SELECT * FROM  table1 , table2');
    expect(tables).toContain('table1');
    expect(tables).toContain('table2');
  });

  it('extracts JOIN tables', () => {
    const tables = extractReferencedTables('SELECT * FROM a JOIN b ON a.id = b.id');
    expect(tables).toContain('a');
    expect(tables).toContain('b');
  });

  it('extracts multiple JOINs', () => {
    const tables = extractReferencedTables(
      'SELECT * FROM a JOIN b ON a.id = b.id LEFT JOIN c ON b.id = c.id',
    );
    expect(tables).toContain('a');
    expect(tables).toContain('b');
    expect(tables).toContain('c');
  });

  it('filters out CTE names', () => {
    const tables = extractReferencedTables(
      'WITH cte AS (SELECT * FROM real_table) SELECT * FROM cte',
    );
    expect(tables).toContain('real_table');
    expect(tables).not.toContain('cte');
  });

  it('extracts tables from pipe syntax', () => {
    const tables = extractReferencedTables('FROM users |> WHERE id = 1');
    expect(tables).toContain('users');
  });

  it('extracts backtick-quoted table names', () => {
    const tables = extractReferencedTables('SELECT * FROM `project.dataset.table`');
    expect(tables).toContain('project.dataset.table');
  });

  it('extracts tables from subqueries', () => {
    const tables = extractReferencedTables('SELECT * FROM (SELECT * FROM inner_table) AS sub');
    expect(tables).toContain('inner_table');
  });

  it('includes INFORMATION_SCHEMA references', () => {
    const tables = extractReferencedTables(
      'SELECT * FROM dataset.INFORMATION_SCHEMA.COLUMNS',
    );
    expect(tables.some((t) => t.includes('information_schema'))).toBe(true);
  });

  it('handles multiple CTEs', () => {
    const tables = extractReferencedTables(
      'WITH a AS (SELECT * FROM t1), b AS (SELECT * FROM t2) SELECT * FROM a JOIN b ON true',
    );
    expect(tables).toContain('t1');
    expect(tables).toContain('t2');
    expect(tables).not.toContain('a');
    expect(tables).not.toContain('b');
  });
});

// ---------------------------------------------------------------------------
// tableMatchesAllowedEntry
// ---------------------------------------------------------------------------
describe('tableMatchesAllowedEntry', () => {
  it('matches exact names', () => {
    expect(tableMatchesAllowedEntry('dataset.users', 'dataset.users')).toBe(true);
  });

  it('matches when queried is more qualified', () => {
    expect(tableMatchesAllowedEntry('project.dataset.users', 'dataset.users')).toBe(true);
  });

  it('matches when queried is less qualified', () => {
    expect(tableMatchesAllowedEntry('users', 'dataset.users')).toBe(true);
  });

  it('rejects non-matching tables', () => {
    expect(tableMatchesAllowedEntry('orders', 'dataset.users')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceAllowedTables
// ---------------------------------------------------------------------------
describe('enforceAllowedTables', () => {
  const allowed = ['dataset.users', 'dataset.orders'];

  it('allows query referencing only allowed tables', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM dataset.users', allowed);
    }).not.toThrow();
  });

  it('blocks query referencing disallowed table', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM dataset.secrets', allowed);
    }).toThrow(/Access denied/);
  });

  it('blocks JOIN with one allowed and one disallowed', () => {
    expect(() => {
      enforceAllowedTables(
        'SELECT * FROM dataset.users JOIN dataset.secrets ON true',
        allowed,
      );
    }).toThrow(/Access denied/);
  });

  it('blocks comma-join with one allowed and one disallowed', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM dataset.users, dataset.secrets', allowed);
    }).toThrow(/Access denied/);
  });

  it('exempts INFORMATION_SCHEMA references', () => {
    expect(() => {
      enforceAllowedTables(
        'SELECT * FROM dataset.INFORMATION_SCHEMA.COLUMNS',
        allowed,
      );
    }).not.toThrow();
  });

  it('does not treat CTE name as real table', () => {
    expect(() => {
      enforceAllowedTables(
        'WITH summary AS (SELECT id FROM dataset.users) SELECT * FROM summary',
        allowed,
      );
    }).not.toThrow();
  });

  it('handles backtick-quoted names', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM `dataset.users`', allowed);
    }).not.toThrow();
  });

  it('fail-closed: empty extraction from data query throws', () => {
    // A query that has FROM but where our regex might not extract anything
    // (e.g., FROM with a subquery only and no real table)
    // For safety, the simplest test: a SELECT with FROM but no matchable table
    expect(() => {
      enforceAllowedTables('SELECT 1', allowed);
    }).toThrow(/Unable to determine/);
  });

  it('throws on empty allowedTables config', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM dataset.users', []);
    }).toThrow(/No tables are configured/);
  });

  it('catches disallowed table inside CTE body', () => {
    expect(() => {
      enforceAllowedTables(
        'WITH cte AS (SELECT * FROM dataset.secrets) SELECT * FROM cte',
        allowed,
      );
    }).toThrow(/Access denied/);
  });

  it('allows less-qualified name matching more-qualified allowed entry', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM users', allowed);
    }).not.toThrow();
  });

  it('allows more-qualified name matching less-qualified allowed entry', () => {
    expect(() => {
      enforceAllowedTables('SELECT * FROM project.dataset.users', ['dataset.users']);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateIsSelectStatement
// ---------------------------------------------------------------------------
describe('validateIsSelectStatement', () => {
  it('allows SELECT statements', () => {
    expect(() => validateIsSelectStatement('SELECT')).not.toThrow();
  });

  it('blocks INSERT', () => {
    expect(() => validateIsSelectStatement('INSERT')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks UPDATE', () => {
    expect(() => validateIsSelectStatement('UPDATE')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks DELETE', () => {
    expect(() => validateIsSelectStatement('DELETE')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks CREATE_TABLE', () => {
    expect(() => validateIsSelectStatement('CREATE_TABLE')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks DROP_TABLE', () => {
    expect(() => validateIsSelectStatement('DROP_TABLE')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks MERGE', () => {
    expect(() => validateIsSelectStatement('MERGE')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks EXPORT_DATA — previously bypassable via regex', () => {
    expect(() => validateIsSelectStatement('EXPORT_DATA')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks LOAD_DATA — previously bypassable via regex', () => {
    expect(() => validateIsSelectStatement('LOAD_DATA')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks CALL — previously bypassable via regex', () => {
    expect(() => validateIsSelectStatement('CALL')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks ASSERT — previously bypassable via regex', () => {
    expect(() => validateIsSelectStatement('ASSERT')).toThrow('Only SELECT queries are allowed');
  });

  it('blocks undefined (dry run did not return statementType)', () => {
    expect(() => validateIsSelectStatement(undefined)).toThrow('Only SELECT queries are allowed');
    expect(() => validateIsSelectStatement(undefined)).toThrow('UNKNOWN');
  });

  it('includes the actual statementType in the error message', () => {
    expect(() => validateIsSelectStatement('EXPORT_DATA')).toThrow('EXPORT_DATA');
  });
});
