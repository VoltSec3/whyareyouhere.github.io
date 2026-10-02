/**
 * Registers the extensionless-import resolver for Node.
 *
 * Load with: node --import ./scripts/register-ts.mjs <script>
 */
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
