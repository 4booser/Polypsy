// Monorepo-конфиг: Metro должен видеть packages/shared и общий node_modules в корне.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

/*
 * Производственная сборка (expo export, export:embed, EAS — NODE_ENV задаёт
 * Expo CLI до чтения этого файла) берёт словарь оболочки только с записями,
 * до которых дотягивается приложение (metro.strings.js): из девяти тысяч
 * записей общего словаря ему нужно меньше тысячи. Разработка, tsc и bun test
 * читают полный словарь. Копию собрать не вышло — сборка берёт полный.
 */
if (process.env.NODE_ENV === "production") {
  const { DICTIONARY, buildMobileStrings } = require("./metro.strings");
  const built = buildMobileStrings();
  if (built) {
    console.log(`› Словарь приложения: ${built.kept} из ${built.total} записей (metro.strings.js)`);
    const own = config.resolver.resolveRequest;
    config.resolver.resolveRequest = (context, moduleName, platform) => {
      const resolved = (own ?? context.resolveRequest)(context, moduleName, platform);
      return resolved.type === "sourceFile" && resolved.filePath === DICTIONARY
        ? { type: "sourceFile", filePath: built.file }
        : resolved;
    };
  } else {
    console.warn("› Словарь приложения: устройство uiStrings.ts не узнано — в сборку идёт полный (metro.strings.js)");
  }
}

module.exports = config;
