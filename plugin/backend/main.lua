--[[
    成就收藏册 · 插件版后端

    两件事：
      1. 把社区展柜的 JS/CSS 通过 Millennium 的 webkit 注入接口挂到
         steamcommunity 页面；
      2. 前端首次进入卡包时检查 GitHub 最新 release，需要时由这里下载资产并
         替换插件文件（重启 Steam 生效）。

    ⚠️ millennium.add_browser_js / add_browser_css 的第一个参数是
    **相对于 <millennium>/themes/ 的文件路径**，不是文件内容。
    传内容会得到一个指向 "themes/<整个脚本>" 的 404 script 标签，而且
    接口仍然返回模块 id（日志看起来像成功）。所以这里先把构建好的
    showcase.* 复制到 themes 下的插件私有目录，再按相对路径注册。
]]

local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

-- http 是 Millennium 的 libcurl 模块；老版本可能没有，加载失败时只影响更新检查
local ok_http, http = pcall(require, "http")
if not ok_http then http = nil end

local LOG_PREFIX = "[AchievementCollection] "
local SHOWCASE_PATTERN = "https://steamcommunity\\.com(/.*)?"
local SHOWCASE_MARKER = "showcase_achievementscompletionist"
-- themes 下的私有资产目录：不是主题（没有 skin.json），不会出现在主题列表里
local ASSET_DIR = "__ac_showcase"

-- ---------------------------------------------------------------------------
-- 小工具
-- ---------------------------------------------------------------------------

local function log_info(message)
    logger:info(LOG_PREFIX .. tostring(message))
end

local function log_error(message)
    logger:error(LOG_PREFIX .. tostring(message))
end

-- millennium.get_install_path() 返回的是 millennium 根目录（plugins 的上一级），
-- 插件自己的根目录要从 utils.get_backend_path()（.../插件/backend）往上取一层。
local function plugin_root()
    local backend = utils.get_backend_path()
    if backend and backend ~= "" then return fs.parent_path(backend) end
    return millennium.get_install_path() .. "/plugins/AchievementCollection"
end

local function themes_root()
    return millennium.get_install_path() .. "/themes"
end

local function read_file(path)
    local file = io.open(path, "rb")
    if not file then return nil end
    local data = file:read("*a")
    file:close()
    return data
end

local function write_file(path, data)
    local file, err = io.open(path, "wb")
    if not file then return false, err end
    local ok, write_err = file:write(data)
    file:close()
    if not ok then return false, write_err end
    return true
end

local function file_size(path)
    local file = io.open(path, "rb")
    if not file then return nil end
    local size = file:seek("end")
    file:close()
    return size
end

--- 只在真正需要版本号时读 plugin.json。
--- 不用 json.decode：坏文件会让 C 函数抛错，进而破坏 handle_evaluate 的返回地址。
local function read_local_version()
    local data = read_file(plugin_root() .. "/plugin.json")
    if not data then return "unknown" end
    local key = data:find('"version"', 1, true)
    if not key then return "unknown" end
    local colon = data:find(":", key + 9, true)
    if not colon then return "unknown" end
    local open = data:find('"', colon + 1, true)
    if not open then return "unknown" end
    local close = data:find('"', open + 1, true)
    if not close then return "unknown" end
    return data:sub(open + 1, close - 1)
end

--- 内容指纹：改一行脚本或样式就换一个 URL，避免 CEF 命中旧缓存。
--- （Millennium 的虚拟文件响应不带 Cache-Control。）
local function content_tag(data)
    local hash = 5381
    for i = 1, #data do
        hash = (hash * 33 + data:byte(i)) % 4294967296
    end
    return string.format("%08x%x", hash, #data)
end

-- ---------------------------------------------------------------------------
-- 社区展柜注入
-- ---------------------------------------------------------------------------

local showcase = {
    js_path = nil,
    css_path = nil,
    js_id = nil,
    css_id = nil,
}

--- 撤掉自己注册的两个钩子（已被 Millennium 清掉的会返回 false，无副作用）
local function release_showcase_hooks()
    if showcase.js_id ~= nil then
        pcall(millennium.remove_browser_module, showcase.js_id)
        showcase.js_id = nil
    end
    if showcase.css_id ~= nil then
        pcall(millennium.remove_browser_module, showcase.css_id)
        showcase.css_id = nil
    end
end

--- 幂等注册：先撤旧钩子再挂新的，避免重复注入。
--- 钩子 id 从 0 开始，0 是合法值（主题没有钩子时插件拿到的就是 0/1），不能当成失败。
local function register_showcase_hooks()
    if not showcase.js_path or not showcase.css_path then return false end
    release_showcase_hooks()

    local ok_js, js_id = pcall(millennium.add_browser_js, showcase.js_path, SHOWCASE_PATTERN)
    if ok_js and type(js_id) == "number" and js_id >= 0 then
        showcase.js_id = js_id
    else
        log_error("展柜脚本注入失败：" .. tostring(js_id))
    end

    local ok_css, css_id = pcall(millennium.add_browser_css, showcase.css_path, SHOWCASE_PATTERN)
    if ok_css and type(css_id) == "number" and css_id >= 0 then
        showcase.css_id = css_id
    else
        log_error("展柜样式注入失败：" .. tostring(css_id))
    end

    if showcase.js_id ~= nil and showcase.css_id ~= nil then
        log_info(string.format(
            "社区展柜已注入：steamcommunity.com（js #%d · css #%d · %s）",
            showcase.js_id, showcase.css_id, showcase.js_path
        ))
        return true
    end
    return false
end

local function install_showcase()
    local root = plugin_root()
    local js = read_file(root .. "/showcase.js")
    local css = read_file(root .. "/showcase.css")
    if not js or not css then
        log_info("未找到展柜资产，跳过社区展柜（卡包与面板不受影响）")
        return
    end
    if not js:find(SHOWCASE_MARKER, 1, true) or not css:find(SHOWCASE_MARKER, 1, true) then
        log_error("展柜资产内容校验失败，跳过注入")
        return
    end

    local asset_root = themes_root() .. "/" .. ASSET_DIR
    fs.remove_all(asset_root)
    local ok_dir, dir_err = fs.create_directories(asset_root)
    if ok_dir == nil then
        log_error("无法创建展柜资产目录：" .. tostring(dir_err))
        return
    end

    local js_name = "showcase-" .. content_tag(js) .. ".js"
    local css_name = "showcase-" .. content_tag(css) .. ".css"
    local ok_js_file, js_err = write_file(asset_root .. "/" .. js_name, js)
    local ok_css_file, css_err = write_file(asset_root .. "/" .. css_name, css)
    if not ok_js_file or not ok_css_file then
        log_error("写入展柜资产失败：" .. tostring(js_err or css_err))
        return
    end

    -- 第一个参数必须是 themes 下的相对路径
    showcase.js_path = ASSET_DIR .. "/" .. js_name
    showcase.css_path = ASSET_DIR .. "/" .. css_name
    register_showcase_hooks()
end

local function uninstall_showcase()
    release_showcase_hooks()
    showcase.js_path = nil
    showcase.css_path = nil
    -- 钩子已撤掉，磁盘上的副本没有用了；下次加载会按内容指纹重新生成
    pcall(fs.remove_all, themes_root() .. "/" .. ASSET_DIR)
end

-- ---------------------------------------------------------------------------
-- 自更新：检查 GitHub release，下载并替换插件文件
-- ---------------------------------------------------------------------------

local UPDATE_REPO = "Kevin0036/steam_achievement_improve"
local UPDATE_API = "https://api.github.com/repos/" .. UPDATE_REPO .. "/releases/latest"
local UPDATE_HOST = "https://github.com/" .. UPDATE_REPO .. "/releases/download/"

-- release 资产名 → 本地相对路径
local UPDATE_TARGETS = {
    ["AchievementCollection-plugin.js"] = ".millennium/Dist/index.js",
    ["AchievementCollection-backend.lua"] = "backend/main.lua",
    ["AchievementCollection-showcase.js"] = "showcase.js",
    ["AchievementCollection-showcase.css"] = "showcase.css",
}

-- 固定下载顺序，出错时日志可读
local UPDATE_ORDER = {
    "AchievementCollection-backend.lua",
    "AchievementCollection-showcase.js",
    "AchievementCollection-showcase.css",
    "AchievementCollection-plugin.js",
}

--- 逐字符解析 1.2.3 / v1.2.3。
--- 不用 Lua 模式（`^%d+(%.%d+)*$` 这种分组量词在 Lua 里永远匹配不上），
--- 也不用 json.decode：它们一旦抛错就会连累后端求值调用。
local function version_parts(value)
    if type(value) ~= "string" then return nil end
    local text = value
    local first = text:sub(1, 1)
    if first == "v" or first == "V" then text = text:sub(2) end
    -- 预发布后缀（1.1.7-beta）只影响显示，比较时按 1.1.7 处理
    local dash = text:find("-", 1, true)
    if dash then text = text:sub(1, dash - 1) end
    if text == "" then return nil end

    local parts = {}
    local current = 0
    local digits = 0
    for i = 1, #text do
        local byte = text:byte(i)
        if byte >= 48 and byte <= 57 then
            current = current * 10 + (byte - 48)
            digits = digits + 1
        elseif byte == 46 and digits > 0 then
            parts[#parts + 1] = current
            current = 0
            digits = 0
        else
            return nil
        end
    end
    if digits == 0 then return nil end
    parts[#parts + 1] = current
    return parts
end

--- 规范化成 x.y.z，内测后缀保留：它决定装完之后还能不能收到同号的正式版。
--- 位数不对的一律拒绝；这个值会写进 plugin.json，后缀只放行字母数字、点和连字符。
local function release_version(value)
    local parts = version_parts(value)
    if not parts or #parts ~= 3 then return nil end
    local text = table.concat(parts, ".")
    local dash = value:find("-", 1, true)
    if not dash then return text end
    local suffix = value:sub(dash)
    if suffix:find("[^%w%.%-]") then return nil end
    return text .. suffix
end

local function tag_matches_version(tag, version)
    if type(tag) ~= "string" or tag:sub(1, 1) ~= "v" then return false end
    local tag_parts = version_parts(tag)
    local version_parts_value = version_parts(version)
    if not tag_parts or not version_parts_value or #tag_parts ~= #version_parts_value then
        return false
    end
    for i = 1, #tag_parts do
        if tag_parts[i] ~= version_parts_value[i] then return false end
    end
    return true
end

local function is_prerelease(value)
    return type(value) == "string" and value:find("-", 1, true) ~= nil
end

local function version_newer(candidate, current)
    local a = version_parts(candidate)
    local b = version_parts(current)
    if not a or not b then return false end
    for i = 1, math.max(#a, #b) do
        local left = a[i] or 0
        local right = b[i] or 0
        if left ~= right then return left > right end
    end
    -- 数字相同时正式版比内测版新，和前端的 isNewerVersion 保持一致
    return is_prerelease(current) and not is_prerelease(candidate)
end

local function http_get(url, accept)
    if not http then return nil, "当前 Millennium 后端不支持网络请求" end
    local options = {
        headers = {
            ["User-Agent"] = "AchievementCollection/" .. read_local_version(),
            ["Accept"] = accept or "application/vnd.github+json",
        },
        timeout = 20,
        follow_redirects = true,
    }
    local response, err = http.get(url, options)
    if not response then return nil, err or "网络请求失败" end
    if response.status ~= 200 then return nil, string.format("HTTP %s", tostring(response.status)) end
    return response.body or ""
end

--- 先写临时文件再替换，避免写到一半留下损坏的插件文件
local function replace_file(path, data)
    local temp = path .. ".update"
    local ok, err = write_file(temp, data)
    if not ok then return false, err end
    os.remove(path)
    local renamed = os.rename(temp, path)
    if renamed then return true end
    local ok_write, write_err = write_file(path, data)
    os.remove(temp)
    return ok_write, write_err
end

--- 只改 plugin.json 里的 version 值，保留原有字段与排版（不经过 json.encode）。
local function write_manifest_version(path, version)
    local text = read_file(path)
    if not text then return false, "无法读取 plugin.json" end
    local key = text:find('"version"', 1, true)
    if not key then return false, "plugin.json 缺少 version 字段" end
    local colon = text:find(":", key + 9, true)
    if not colon then return false, "plugin.json 格式异常" end
    local open = text:find('"', colon + 1, true)
    if not open then return false, "plugin.json 格式异常" end
    local close = text:find('"', open + 1, true)
    if not close then return false, "plugin.json 格式异常" end
    return replace_file(path, text:sub(1, open) .. version .. text:sub(close))
end

--- 大文件必须流式落盘。http.get 会把整个响应体塞进 RPC/JSON，
--- 几百 KB 的插件包就可能让 Lua 子进程访问冲突。
local function download_asset(url, path, expected)
    if type(http.download) ~= "function" then
        return false, "当前 Millennium 后端不支持流式下载，请手动更新"
    end
    os.remove(path)
    local called, result, err = pcall(http.download, url, path, {
        timeout = 60,
        follow_redirects = true,
        headers = {
            ["User-Agent"] = "AchievementCollection/" .. read_local_version(),
            ["Accept"] = "application/octet-stream",
        },
    })
    if not called then return false, tostring(result) end
    if not result then return false, err or "下载失败" end
    if tonumber(result.status) ~= 200 then
        return false, "HTTP " .. tostring(result.status)
    end
    local actual = file_size(path)
    if not actual or actual <= 0 then return false, "下载文件为空" end
    if expected > 0 and actual ~= expected then
        return false, string.format("下载大小不一致（%d/%d）", actual, expected)
    end
    return true, actual
end

--- 网络断一下很常见，四个文件里只要一个超时就得整次重来，所以当场多试一次
local function download_with_retry(url, path, expected)
    local ok, info = download_asset(url, path, expected)
    if ok then return ok, info end
    log_info("下载失败，重试一次：" .. tostring(info))
    os.remove(path)
    return download_asset(url, path, expected)
end

--- 只取 tag_name 写日志；纯字符串操作，遇到代理页/限流页也不会抛错。
local function release_tag(body)
    if type(body) ~= "string" then return nil end
    local key = body:find('"tag_name"', 1, true)
    if not key then return nil end
    local colon = body:find(":", key + 10, true)
    if not colon then return nil end
    local open = body:find('"', colon + 1, true)
    if not open then return nil end
    local close = body:find('"', open + 1, true)
    if not close then return nil end
    local tag = body:sub(open + 1, close - 1)
    if tag == "" then return nil end
    return tag
end

--- 只负责把 GitHub 的原始 JSON 取回来，解析交给前端。
--- 后端拿坏响应（代理拦截页 / 限流页）时不能碰 json.decode，否则会崩掉求值调用。
function FetchRelease()
    local body, err = http_get(UPDATE_API)
    if not body then
        log_error("检查更新失败：" .. tostring(err))
        return { success = false, error = err or "网络请求失败", current = read_local_version() }
    end
    log_info("检查更新：GitHub 最新版本 " .. (release_tag(body) or "未知"))
    return { success = true, raw = body, current = read_local_version() }
end

function InstallUpdate(payload)
    if not http then
        return { success = false, error = "当前 Millennium 后端不支持网络请求" }
    end
    if type(payload) ~= "table" then
        return { success = false, error = "更新参数格式错误" }
    end

    local version = release_version(tostring(payload.version or ""))
    if not version then
        return { success = false, error = "更新版本号无效" }
    end
    local current = read_local_version()
    if not version_newer(version, current) then
        return { success = false, error = "目标版本不比当前版本新", current = current }
    end

    local tag = tostring(payload.tag or "")
    if tag == "" then tag = "v" .. version end
    if not tag_matches_version(tag, version) then
        return { success = false, error = "更新标签无效" }
    end

    local assets = payload.assets
    if type(assets) ~= "table" then
        return { success = false, error = "更新清单缺少资产列表" }
    end

    local root = plugin_root()
    local downloads = {}
    local function cleanup()
        for _, item in ipairs(downloads) do
            pcall(os.remove, item.temp)
        end
    end

    for _, name in ipairs(UPDATE_ORDER) do
        local relative = UPDATE_TARGETS[name]
        local asset = assets[name]
        local url = type(asset) == "table" and asset.url or nil
        if type(url) ~= "string" or url:sub(1, #UPDATE_HOST) ~= UPDATE_HOST then
            cleanup()
            return { success = false, error = "更新清单缺少 " .. name }
        end
        if not url:find("/releases/download/" .. tag .. "/", 1, true) then
            cleanup()
            return { success = false, error = "资产地址与版本不匹配：" .. name }
        end

        local temp = root .. "/" .. relative .. ".update"
        log_info("正在下载 " .. name)
        local ok, info = download_with_retry(url, temp, tonumber(asset.size) or 0)
        if not ok then
            os.remove(temp)
            cleanup()
            return { success = false, error = "下载失败：" .. name .. "（" .. tostring(info) .. "）" }
        end
        downloads[#downloads + 1] = { relative = relative, temp = temp }
        log_info("已下载 " .. name .. "（" .. tostring(info) .. " 字节）")
    end

    local manifest_path = root .. "/plugin.json"
    if not read_file(manifest_path) then
        cleanup()
        return { success = false, error = "无法读取 plugin.json" }
    end

    -- 旧文件先改名留底，全部换完才删。中途失败就全部换回去：
    -- 半新半旧的插件可能连卡包都打不开，那样连自动更新都用不了了。
    local swapped = {}
    local function roll_back()
        for i = #swapped, 1, -1 do
            local item = swapped[i]
            os.remove(item.target)
            if item.backup then os.rename(item.backup, item.target) end
        end
        cleanup()
    end

    for _, item in ipairs(downloads) do
        local target = root .. "/" .. item.relative
        local backup = target .. ".previous"
        local has_old = file_size(target) ~= nil
        os.remove(backup)
        if has_old and not os.rename(target, backup) then
            roll_back()
            return { success = false, error = "写入失败：" .. item.relative .. "（旧文件被占用）" }
        end
        swapped[#swapped + 1] = { target = target, backup = has_old and backup or nil }
        if not os.rename(item.temp, target) then
            roll_back()
            return { success = false, error = "写入失败：" .. item.relative }
        end
    end

    local wrote, write_err = write_manifest_version(manifest_path, version)
    if not wrote then
        roll_back()
        return { success = false, error = "写入 plugin.json 失败：" .. tostring(write_err) }
    end

    for _, item in ipairs(swapped) do
        if item.backup then os.remove(item.backup) end
    end

    log_info("插件已更新到 v" .. version .. "，重启 Steam 后生效")
    return { success = true, version = version }
end

-- ---------------------------------------------------------------------------
-- 生命周期
-- ---------------------------------------------------------------------------

local function on_load()
    log_info("后端已加载 · 当前版本 " .. read_local_version())
    install_showcase()
    millennium.ready()
end

-- Millennium 在主题配置变化时会调用 theme_webkit_mgr::unregister_all()，
-- 把主题和插件注册的浏览器钩子一起清掉（切换主题、改强调色、改启用插件都可能触发）。
-- 前端每隔一段时间会重发一次 FRONT_END_LOADED，这里借此把展柜钩子补回去。
local function on_frontend_loaded()
    if not showcase.js_path or not showcase.css_path then
        -- 上次资产没写成功：整份重来一次
        install_showcase()
        return
    end
    register_showcase_hooks()
end

local function on_unload()
    uninstall_showcase()
    log_info("后端已卸载")
end

return {
    on_load = on_load,
    on_frontend_loaded = on_frontend_loaded,
    on_unload = on_unload,
}
