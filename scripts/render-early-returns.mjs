#!/usr/bin/env node
/**
 * Convert top-level early returns in a returned render function into a
 * reactive ternary. Only the render function body is touched; nested callbacks
 * (map/filter/dialog renderers) are left alone.
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

const onlyReturn = (stmt) => {
    if (ts.isReturnStatement(stmt) && stmt.expression) return stmt;
    if (ts.isBlock(stmt)) {
        if (stmt.statements.length !== 1) return null;
        const first = stmt.statements[0];
        if (ts.isReturnStatement(first) && first.expression) return first;
    }
    return null;
};

let changed = 0;
for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits = [];

    const visit = (node) => {
        if (
            ts.isReturnStatement(node) &&
            node.expression &&
            ts.isArrowFunction(node.expression) &&
            ts.isBlock(node.expression.body)
        ) {
            const block = node.expression.body;
            const last = block.statements[block.statements.length - 1];
            if (last && ts.isReturnStatement(last) && last.expression) {
                const branches = [];
                let index = block.statements.length - 2;
                while (index >= 0) {
                    const stmt = block.statements[index];
                    if (!ts.isIfStatement(stmt) || stmt.elseStatement) break;
                    const ret = onlyReturn(stmt.thenStatement);
                    if (!ret) break;
                    branches.unshift({ cond: stmt.expression.getText(sf), expr: ret.expression.getText(sf), start: stmt.getStart(sf) });
                    index -= 1;
                }
                if (branches.length) {
                    let expr = last.expression.getText(sf);
                    for (let i = branches.length - 1; i >= 0; i -= 1) {
                        expr = `${branches[i].cond} ? ${branches[i].expr} : ${expr}`;
                    }
                    edits.push({ start: branches[0].start, end: last.getEnd(), text: `return (${expr});` });
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
        changed += 1;
    }
}
console.log(`render early returns: ${changed}/${files.length} files updated in ${root}`);
