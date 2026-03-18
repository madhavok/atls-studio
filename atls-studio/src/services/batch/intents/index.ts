/**
 * Intent resolver barrel — imports all resolvers and registers them.
 */

import { registerIntent } from '../intents';
import { resolveUnderstand } from './understand';
import { resolveEdit } from './edit';
import { resolveEditMulti } from './editMulti';
import { resolveInvestigate } from './investigate';
import { resolveDiagnose } from './diagnose';
import { resolveSurvey } from './survey';
import { resolveRefactor } from './refactor';
import { resolveCreate } from './create';
import { resolveTest } from './test';
import { resolveSearchReplace } from './searchReplace';
import { resolveExtract } from './extract';

registerIntent('intent.understand', resolveUnderstand);
registerIntent('intent.edit', resolveEdit);
registerIntent('intent.edit_multi', resolveEditMulti);
registerIntent('intent.investigate', resolveInvestigate);
registerIntent('intent.diagnose', resolveDiagnose);
registerIntent('intent.survey', resolveSurvey);
registerIntent('intent.refactor', resolveRefactor);
registerIntent('intent.create', resolveCreate);
registerIntent('intent.test', resolveTest);
registerIntent('intent.search_replace', resolveSearchReplace);
registerIntent('intent.extract', resolveExtract);
