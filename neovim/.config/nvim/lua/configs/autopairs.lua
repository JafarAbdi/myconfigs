local ok, npairs = pcall(require, "nvim-autopairs")
if not ok then
  return
end
npairs.setup({
  check_ts = true,
  map_c_h = true,
  map_c_w = true,
})
