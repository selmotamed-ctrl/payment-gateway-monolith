#!/usr/bin/env node
/**
 * Convert trailing `if (cond) return X; ... return Y;` chains into a single
 * ternary. Vapor setup returns a block once, so a reactive `if` around the
 * returned JSX is otherwise evaluated only on the first render.
 */
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const root = process.argv[2];
if (!root) process.exit(1);

const files = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && entry.name !== "dist") walk(p);
        } else if (p.endsWith(".tsx")) files.push(p);
    }
}
walk(path.join(root, "src"));

const isJsx = (node) => {
    if (!node) return false;
    let found = false;
    const visit = (n) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
};

const returnedExpression = (stmt) => {
    if (ts.isReturnStatement(stmt) && stmt.expression) return { expr: stmt.expression, node: stmt };
    if (ts.isBlock(stmt)) {
        const last = stmt.statements[stmt.statements.length - 1];
        if (last && ts.isReturnStatement(last) && last.expression) return { expr: last.expression, node: stmt };
    }
    return null;
};

let changedFiles = 0;
for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits = [];

    const visit = (node) => {
        if (ts.isBlock(node) && node.statements.length >= 2) {
            const last = node.statements[node.statements.length - 1];
            if (ts.isReturnStatement(last) && last.expression) {
                const branches = [];
                let index = node.statements.length - 2;
                while (index >= 0) {
                    const stmt = node.statements[index];
                    if (!ts.isIfStatement(stmt) || stmt.elseStatement) break;
                    const branch = returnedExpression(stmt.thenStatement);
                    if (!branch) break;
                    branches.unshift({ cond: stmt.expression.getText(sf), expr: branch.expr.getText(sf), start: stmt.getStart(sf) });
                    index -= 1;
                }
                if (branches.length > 0) {
                    const finalExpr = last.expression.getText(sf);
                    const all = [...branches.map((b) => b.expr), finalExpr];
                    if (all.some((value) => value.includes("<"))) {
                        const first = branches[0];
                        let expr = finalExpr;
                        for (let i = branches.length - 1; i >= 0; i -= 1) {
                            expr = `${branches[i].cond} ? ${branches[i].expr} : ${expr}`;
                        }
                        edits.push({ start: first.start, end: last.getEnd(), text: `return (${expr});` });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    if (edits.length) {
        let out = text;
        for (const edit of edits.sort((a, b) => b.start - a.start)) {
            out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
        }
        fs.writeFileSync(file, out);
        changedFiles += 1;
    }
}

console.log(`early-return transform: ${changedFiles}/${files.length} files changed in ${root}`);
