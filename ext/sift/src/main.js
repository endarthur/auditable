// @gcu/sift — the safe, structured predicate lib the selection/linking contract
// rests on. One module today (predicate.js); kept as a manifest for symmetry
// with the other concat libs and room to grow (e.g. a set-algebra combinator).
//
// Module manifest (build concat order):
//   predicate.js — structured boolean-expr spec + validator + evaluator + parser

export * from './predicate.js';
