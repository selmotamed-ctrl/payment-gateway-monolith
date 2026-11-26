#!/usr/bin/env node
/**
 * PageHeader's action area used a `end={() => ...}` function prop. A function
 * returning Vapor blocks is context-bound; pass the same JSX as the default
 * slot instead so it is created in the parent render context.
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

let changed = 0;
for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits = [];
    const visit = (node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "PageHeader") {
            const attributes = node.attributes.properties;
            const end = attributes.find((a) => a.name?.getText(sf) === "end");
            if (end && ts.isJsxAttribute(end) && end.initializer && ts.isJsxExpression(end.initializer)) {
                const value = end.initializer.expression;
                let expr = value?.getText(sf) ?? "";
                if (value && ts.isArrowFunction(value)) {
                    if (ts.isBlock(value.body)) {
                        const ret = value.body.statements.find((s) => ts.isReturnStatement(s) && s.expression);
                        expr = ret && ts.isReturnStatement(ret) && ret.expression ? ret.expression.getText(sf) : "";
                    } else {
                        expr = value.body.getText(sf);
                    }
                }
                if (!expr) return;
                const rest = attributes.filter((a) => a !== end).map((a) => a.getText(sf)).join(" ");
                edits.push({
                    start: node.getStart(sf),
                    end: node.getEnd(),
                    text: `<PageHeader${rest ? ` ${rest}` : ""}>${expr}</PageHeader>`,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    if (edits.length) {
        let out = text;
        for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
        fs.writeFileSync(file, out);
        changed += 1;
    }
}
console.log(`page-header actions: ${changed}/${files.length} files updated in ${root}`);
