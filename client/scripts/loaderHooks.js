import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The client source uses Vite-style extensionless relative imports (e.g.
// `import ... from "./EngineBridge"`). Plain Node ESM does not resolve those, so
// this hook appends `.js` for relative specifiers when a matching file exists.
// It only affects relative specifiers without an extension and always defers to
// the default resolver otherwise.
export async function resolve(specifier, context, nextResolve) {

    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

    const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);

    if (isRelative && !hasExtension && context.parentURL) {

        const parentPath = fileURLToPath(context.parentURL);

        const candidate = resolvePath(dirname(parentPath), `${specifier}.js`);

        if (existsSync(candidate)) {

            return {
                url: pathToFileURL(candidate).href,
                shortCircuit: true
            };

        }

    }

    return nextResolve(specifier, context);

}
