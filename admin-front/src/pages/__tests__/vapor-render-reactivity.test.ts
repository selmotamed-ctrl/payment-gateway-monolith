import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PAGES_ROOT = fileURLToPath(new URL("..", import.meta.url));

const walk = (directory: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry === "__tests__") continue;
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) files.push(...walk(full));
        else if (entry.endsWith(".tsx")) files.push(full);
    }
    return files;
};

const REACTIVE_FACTORIES = new Set(["ref", "computed", "shallowRef", "reactive"]);

type Violation = { file: string; line: number; locals: string[] };

/**
 * Vapor evaluates a component render function once. Reactive values read into
 * plain locals at the top of that function are snapshots: the loading branch
 * never flips to the loaded branch unless the component opts into
 * `rerender: true` (the DynamicFragment path of `dc`/`defineComponent`).
 *
 * This is the exact regression that made the join-request and KYB detail pages
 * report "not found" after a successful API response.
 */
const findViolations = (file: string): Violation[] => {
    const text = readFileSync(file, "utf8");
    if (!/\bdc\(|\bdefineComponent\(/.test(text)) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const violations: Violation[] = [];

    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const name = ts.isIdentifier(node.expression) ? node.expression.text : "";
            if (name === "dc" || name === "defineComponent") {
                const first = node.arguments[0];
                const options = node.arguments[1];
                const optionsText = options?.getText(source) ?? "";
                const hasRerender =
                    /rerender\s*:\s*true/.test(optionsText) ||
                    (first !== undefined &&
                        ts.isObjectLiteralExpression(first) &&
                        first.properties.some(
                            (property) =>
                                ts.isPropertyAssignment(property) &&
                                ts.isIdentifier(property.name) &&
                                property.name.text === "rerender" &&
                                property.initializer.kind === ts.SyntaxKind.TrueKeyword,
                        ));

                let setupBody: ts.Block | undefined;
                if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) && ts.isBlock(first.body)) {
                    setupBody = first.body;
                } else if (first && ts.isObjectLiteralExpression(first)) {
                    for (const property of first.properties) {
                        if (
                            ts.isPropertyAssignment(property) &&
                            ts.isIdentifier(property.name) &&
                            property.name.text === "setup" &&
                            (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) &&
                            ts.isBlock(property.initializer.body)
                        ) {
                            setupBody = property.initializer.body;
                        }
                    }
                }
                if (!setupBody || hasRerender) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const localReactive = new Set<string>();
                for (const statement of setupBody.statements) {
                    if (!ts.isVariableStatement(statement)) continue;
                    for (const declaration of statement.declarationList.declarations) {
                        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
                        if (!ts.isCallExpression(declaration.initializer)) continue;
                        const factory = declaration.initializer.expression;
                        if (ts.isIdentifier(factory) && REACTIVE_FACTORIES.has(factory.text)) {
                            localReactive.add(declaration.name.text);
                        }
                    }
                }
                if (localReactive.size === 0) {
                    ts.forEachChild(node, visit);
                    return;
                }

                for (const statement of setupBody.statements) {
                    if (!ts.isReturnStatement(statement) || !statement.expression) continue;
                    const render = statement.expression;
                    if (
                        !(ts.isArrowFunction(render) || ts.isFunctionExpression(render)) ||
                        !ts.isBlock(render.body)
                    ) {
                        continue;
                    }
                    const snapshots: Array<{ name: string; initializer: string }> = [];
                    for (const inner of render.body.statements) {
                        if (ts.isVariableStatement(inner)) {
                            for (const declaration of inner.declarationList.declarations) {
                                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
                                const initializer = declaration.initializer.getText(source);
                                if (
                                    [...localReactive].some((reactive) =>
                                        new RegExp(`\\b${reactive}\\s*\\.\\s*value\\b`).test(initializer),
                                    )
                                ) {
                                    snapshots.push({ name: declaration.name.text, initializer });
                                }
                            }
                        }
                        if (ts.isReturnStatement(inner)) break;
                    }
                    if (snapshots.length === 0) continue;
                    const renderText = render.body.getText(source);
                    const used = snapshots.filter(
                        (snapshot) =>
                            (renderText.match(new RegExp(`\\b${snapshot.name}\\b`, "g")) ?? []).length > 1,
                    );
                    if (used.length === 0) continue;
                    violations.push({
                        file: relative(PAGES_ROOT, file),
                        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                        locals: used.map(
                            (snapshot) =>
                                `${snapshot.name} = ${snapshot.initializer.replace(/\s+/g, " ").slice(0, 80)}`,
                        ),
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(source);
    return violations;
};

describe("Vapor page render reactivity", () => {
    it("does not snapshot setup refs in a one-shot render without rerender: true", () => {
        const violations = walk(PAGES_ROOT).flatMap(findViolations);
        expect(
            violations.map(
                (violation) =>
                    `${violation.file}:${violation.line} snapshots ${violation.locals.join(", ")} without { rerender: true }`,
            ),
        ).toEqual([]);
    });
});
