import type { Database } from 'bun:sqlite';
import type { Representation } from '$lib/types/v3';
import { recipeHandling, type RecipeRecord } from './recipes';

export const ruleModelKey = (recipe: Pick<RecipeRecord, 'key' | 'version'>) => `deterministic/${recipe.key}/v${recipe.version}`;

/** Store a recipe match as a reviewable assessment without a Jev call. */
export function saveRuleAssessment(db: Database, accountId: string, runId: string, policyId: string, rubricVersion: number, rep: Representation, inputKey: string, recipe: Pick<RecipeRecord, 'key' | 'version' | 'spec'>): string {
  const result = recipeHandling(recipe.spec), model = ruleModelKey(recipe);
  const cached=db.query("SELECT id FROM v3_assessments WHERE account_id=? AND thread_id=? AND input_key=? AND policy_id=? AND model=? AND assessment_source='rule' AND deterministic_version=? ORDER BY created_at DESC LIMIT 1").get(accountId,rep.threadId,inputKey,policyId,model,recipe.version) as {id:string}|null;
  const id=cached?.id??crypto.randomUUID();
  if(!cached) db.query(`INSERT INTO v3_assessments(id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,priority,status,assessment_source,deterministic_rule,deterministic_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rule',?,?,?)`).run(id,accountId,rep.threadId,inputKey,policyId,rubricVersion,model,JSON.stringify(rep),result.action,result.finalAction,result.lane,result.reason,result.priority,result.status,recipe.key,recipe.version,Date.now());
  db.query('INSERT OR IGNORE INTO v3_run_items(run_id,assessment_id) VALUES(?,?)').run(runId,id);
  return id;
}
