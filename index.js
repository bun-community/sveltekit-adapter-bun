import {createReadStream, createWriteStream, existsSync, readFileSync, statSync, writeFileSync} from 'fs';
import {pipeline} from 'stream';
import glob from 'tiny-glob';
import {fileURLToPath} from 'url';
import {promisify} from 'util';
import zlib from 'zlib';
import {rollup} from 'rollup';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const pipe = promisify(pipeline);

const files = fileURLToPath(new URL('./files', import.meta.url).href);

/** @type {import('.').default} */
export default function (opts = {}) {
    const {
        out = 'build',
        precompress = false,
        envPrefix = '',
        development = false,
        dynamic_origin = false,
        xff_depth = 1,
        assets = true
    } = opts;
    return {
        name: 'svelte-adapter-bun',
        async adapt(builder) {

            const tmp = builder.getBuildDirectory('adapter-bun');

            builder.rimraf(out);
            builder.rimraf(tmp);

            builder.log.minor('Copying assets');
            builder.writeClient(`${out}/client`);
            builder.writeServer(`${tmp}`);
            builder.writePrerendered(`${out}/prerendered`);


            writeFileSync(
                `${tmp}/manifest.js`,
                `export const manifest = ${builder.generateManifest({
                                                                        relativePath: './'
                                                                    })};\n`
            );

            const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

            let src = readFileSync(`${tmp}/index.js`, 'utf8');
            const regex = /(this\.options\.hooks\s+=\s+{)\s+(handle:)/gm;
            const subst = `$1 \n\t\thandleWebsocket: module.handleWebsocket || null,\n\t\t$2`;
            const result = src.replace(regex, subst);

            writeFileSync(`${tmp}/index.js`, result, 'utf8');


            const bundle = await rollup({
                                            input:    {
                                                index:    `${tmp}/index.js`,
                                                manifest: `${tmp}/manifest.js`
                                            },
                                            external: [...Object.keys(pkg.dependencies || {})],
                                            plugins:  [nodeResolve({preferBuiltins: true}), commonjs(), json()]
                                        });

            await bundle.write({
                                   dir:            `${out}/server`,
                                   format:         'esm',
                                   sourcemap:      true,
                                   chunkFileNames: `chunks/[name]-[hash].js`
                               });


            builder.copy(files, out, {
                replace: {
                    SERVER:        './server/index.js',
                    MANIFEST:      './server/manifest.js',
                    ENV_PREFIX:    JSON.stringify(envPrefix),
                    dotENV_PREFIX: envPrefix,
                    BUILD_OPTIONS: JSON.stringify({development, dynamic_origin, xff_depth, assets})
                }
            });

            if (precompress) {
                builder.log.minor('Compressing assets');
                await compress(`${out}/client`, precompress);
                await compress(`${out}/static`, precompress);
                await compress(`${out}/prerendered`, precompress);
                builder.log.success("Compression success");
            }


            builder.log.success("Start server with: bun ./build/index.js")
        }
    };
}

/**
 * @param {string} directory
 * @param {import('.').CompressOptions} options
 */
async function compress(directory, options) {
    if (!existsSync(directory)) {
        return;
    }


    let files_ext = options.files ?? ['html', 'js', 'json', 'css', 'svg', 'xml', 'wasm']
    const files = await glob(`**/*.{${files_ext.join()}}`, {
        cwd:       directory,
        dot:       true,
        absolute:  true,
        filesOnly: true
    });

    let doBr = false, doGz = false;

    if (options === true) {
        doBr = doGz = true
    } else if (typeof options == "object") {
        doBr = options.brotli ?? false
        doGz = options.gzip ?? false
    }

    await Promise.all(
        files.map((file) => Promise.all([
                                            doGz && compress_file(file, 'gz'),
                                            doBr && compress_file(file, 'br')
                                        ]))
    );
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file, format = 'gz') {
    const compress =
        format === 'br'
            ? zlib.createBrotliCompress({
                                            params: {
                                                [zlib.constants.BROTLI_PARAM_MODE]:      zlib.constants.BROTLI_MODE_TEXT,
                                                [zlib.constants.BROTLI_PARAM_QUALITY]:   zlib.constants.BROTLI_MAX_QUALITY,
                                                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size
                                            }
                                        })
            : zlib.createGzip({level: zlib.constants.Z_BEST_COMPRESSION});

    const source = createReadStream(file);
    const destination = createWriteStream(`${file}.${format}`);

    await pipe(source, compress, destination);
}