// Settings for `web-ext lint` / `web-ext build`: only the addon files go into the package
export default {
    ignoreFiles: [
        '.github',
        'node_modules',
        'package.json',
        'package-lock.json',
        'web-ext-config.mjs',
        'web-ext-artifacts',
        'tests',
        'screens',
        'store',
        'docs',
        // Service git scripts (symlinks to ../sh/backup/git)
        '*.sh',
        // Not used by the addon (picture for the repository)
        'icons/xdebug.png',
        '*.md'
    ]
};
