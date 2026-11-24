import type { UiInputs, UiOutputs, UiPath } from '@agent-board/shared/ui';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from './router';

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;

type At<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

type Has<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Has<T[Head], Rest>
    : false
  : P extends keyof T
    ? true
    : false;

/** Paths whose declared input the router would not accept. */
type InputDrift = { [P in UiPath]: [UiInputs[P]] extends [At<RouterInputs, P>] ? never : P }[UiPath];

/** Paths whose router output is not assignable to the declared output. */
type OutputDrift = { [P in UiPath]: [At<RouterOutputs, P>] extends [UiOutputs[P]] ? never : P }[UiPath];

/** Paths of the list the router does not have. */
type MissingProcedure = { [P in UiPath]: Has<RouterInputs, P> extends true ? never : P }[UiPath];

/** Paths of the list without a declared input or output, and declarations of a path not in the list. */
type Undeclared = Exclude<UiPath, keyof UiInputs & keyof UiOutputs>;
type Extra = Exclude<keyof UiInputs | keyof UiOutputs, UiPath>;

type Agree<Drift> = [Drift] extends [never] ? true : Drift;
type Assert<T extends true> = T;

/** Fails to compile, naming the paths in the error, while the router and the declarations disagree. */
export type UiConformance = [
  Assert<Agree<InputDrift>>,
  Assert<Agree<OutputDrift>>,
  Assert<Agree<MissingProcedure>>,
  Assert<Agree<Undeclared>>,
  Assert<Agree<Extra>>,
];
