local is_parent = require("configs.functions").is_parent
local Project = require("projects").Project
local p = require("projects")
local projects = require("projects").projects

describe("Testing is_parent function", function()
  it("TODO", function()
    local ws_dir = "/home/jafar/workspaces/rust/scratches"
    assert(is_parent(ws_dir, ws_dir .. "/Cargo.toml"))
    assert(is_parent(ws_dir, ws_dir))
    assert(not is_parent(ws_dir, ws_dir .. ".bak"))
    assert(not is_parent(ws_dir .. ".bak", ws_dir))
    assert(is_parent(ws_dir, ws_dir .. "/asdsa/asdasd"))
    assert(not is_parent(ws_dir, "/asd/asd"))
    assert(not is_parent(ws_dir, "/home/jafar/workspaces"))
    assert(is_parent(ws_dir, ws_dir .. "/"))
    assert(is_parent(ws_dir .. "/", ws_dir))
    assert(not is_parent(ws_dir, ws_dir .. ".bak/asd.rs"))
  end)
end)

describe("Testing projects", function()
  it("TODO", function()
    local p1_path = "/home/jafar/workspaces/rust/scratches"
    p.add_project(p1_path, Project:new({ language = "rust", build_system = "cargo" }))
    local p2_path = "/home/jafar/workspaces/rust/scratches.bak/asd.rs"
    p.add_project(p2_path, Project:new({ language = "rust", build_system = "standalone" }))
    local p3_path = "/tmp/rust/asdas.rs"
    p.add_project(p3_path, Project:new({ language = "rust", build_system = "standalone" }))
    local p4_path = "/tmp/cpp/asdas.cpp"
    p.add_project(p4_path, Project:new({ language = "cpp", build_system = "standalone" }))
    local p5_path = "/home/jafar/workspaces/cpp/scratches"
    p.add_project(p5_path, Project:new({ language = "cpp", build_system = "cmake" }))
    local p2 = p.get_project(p2_path)
    assert.are.same(p2.language, "rust")
    assert.are.same(p2.build_system, "standalone")
    assert.are.same(p2.root_path.filename, p2_path)
    local p1 = p.get_project(p1_path)
    assert.are.same(p1.language, "rust")
    assert.are.same(p1.build_system, "cargo")
    assert.are.same(p1.root_path.filename, p1_path)
    local p3 = p.get_project(p3_path)
    assert.are.same(p3.language, "rust")
    assert.are.same(p3.build_system, "standalone")
    assert.are.same(p3.root_path.filename, p3_path)
    local p4 = p.get_project(p4_path)
    assert.are.same(p4.language, "cpp")
    assert.are.same(p4.build_system, "standalone")
    assert.are.same(p4.root_path.filename, p4_path)
    local p5 = p.get_project(p5_path)
    assert.are.same(p5.language, "cpp")
    assert.are.same(p5.build_system, "cmake")
    assert.are.same(p5.root_path.filename, p5_path)
    assert.are.same(#vim.tbl_keys(projects), 5)
  end)
end)
