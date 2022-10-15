module.exports = {
    apps : [{
        name   : "bun-community",
        script : "./build/index.js",
        interpreter: "bun",
        watch: './build/',
        autorestart: true,
    }]
}