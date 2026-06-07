---
name: einops
description: ALWAYS load before writing, editing, or creating any tensor-reshaping or modeling code — any reshape/transpose/permute/view/squeeze/expand_dims/stack/concat/pooling/channel-or-head-shuffle on JAX, PyTorch, NumPy, or TF arrays. Use einops rearrange/reduce/repeat (+ Rearrange/Reduce layers) for readable, shape-safe array ops instead of opaque .view/.permute/.transpose/einsum chains.
---

# einops: readable, shape-safe tensor ops

Instead of opaque axis-index gymnastics

```python
y = x.transpose(0, 2, 3, 1)              # which axes? to what?
x = x.view(b, -1, h, w)                  # silent on wrong input
```

write what the operation *does*, with named axes:

```python
from einops import rearrange, reduce, repeat
y = rearrange(x, "b c h w -> b h w c")
```

einops works identically across **numpy, pytorch, jax, tensorflow** (notation is universal,
operations backprop), and **fails loudly** on shape mismatch instead of silently producing
garbage.

## The three operations

| Op | Subsumes | Signature |
| :-- | :-- | :-- |
| `rearrange` | transpose, reshape, stack, concatenate, squeeze, expand_dims | `rearrange(x, "b c h w -> b (c h w)")` |
| `reduce` | mean/max/sum/min/prod, all pooling, global pooling | `reduce(x, "b c h w -> b c", "mean")` |
| `repeat` | repeat, tile, broadcast to new axes | `repeat(x, "h w -> h (repeat w)", repeat=3)` |

`rearrange` never changes the element count; `reduce` drops axes (any axis absent from the
output is reduced); `repeat` adds elements. `reduce` and `repeat` are inverses of each other.

## Pattern language

| Construct | Meaning | Example |
| :-- | :-- | :-- |
| `(a b)` (right side) | **compose** axes into one (product of lengths) | `b h w c -> h (b w) c` |
| `(a b)` (left side) | **decompose** one axis; give one length | `(b1 b2) h w c -> b1 b2 h w c`, `b1=2` |
| `1` or `()` | unit axis — add (expand_dims) or, if absent in output, remove (squeeze) | `b c h w -> b c 1 1` |
| `...` | any number of leading/trailing axes | `... h w -> ... (h w)` |
| order inside `()` | **lexicographic** — leftmost axis is most significant | `(b1 b2)` ≠ `(b2 b1)` |
| list/tuple input | the list becomes a new **leading** axis | `rearrange(list_of_tensors, "b h w c -> b h w c")` |

Decomposition needs the size of all-but-one factor: `rearrange(x, "(h h2) w -> h (w h2)", h2=2)`.
You may use full words for axes (`height width color`); short names are convention, not requirement.

## Deep-learning idioms

| Pattern | What it is |
| :-- | :-- |
| `rearrange(x, "b c h w -> b (c h w)")` | flatten conv features before a Linear |
| `rearrange(x, "b c (h h1) (w w1) -> b (h1 w1 c) h w", h1=2, w1=2)` | space-to-depth |
| `rearrange(x, "b (h1 w1 c) h w -> b c (h h1) (w w1)", h1=2, w1=2)` | depth-to-space (pixel-shuffle) |
| `reduce(x, "b c h w -> b c", "mean")` | global average pooling |
| `reduce(x, "b c (h h1) (w w1) -> b c h w", "max", h1=2, w1=2)` | 2×2 max-pool |
| `rearrange(x, "b (g c) h w -> b (c g) h w", g=groups)` | channel shuffle (ShuffleNet) |
| `rearrange(qkv, "b l (head k) -> head b l k", head=n_head)` | split attention heads |
| `rearrange(out, "head b l v -> b l (head v)")` | merge attention heads |
| `rearrange(x, "b (c h2 w2) h w -> b c (h h2) (w w2)", h2=f, w2=f)` | GLOW unsqueeze2d |
| `reduce(x, "b c h w -> b c 1 1", "mean")` | keepdims-style reduction (broadcastable) |
| `rearrange(imgs, "(b1 b2) c h w -> (b1 h) (b2 w) c", b1=8)` | tile a batch into an image grid |

einsum-style contractions stay as `einsum`; einops covers the reshape/transpose/reduce around them.

## Layers for `nn.Sequential`

```python
from einops.layers.torch import Rearrange, Reduce   # or einops.layers.{flax,tensorflow,chainer}

model = nn.Sequential(
    nn.Conv2d(3, 6, kernel_size=5),
    nn.MaxPool2d(kernel_size=2),
    Rearrange("b c h w -> b (c h w)"),               # explicit flatten, errors on wrong shape
    nn.Linear(6 * 5 * 5, 10),
)

resnet_tail = Reduce("b c h w -> b c", "mean")       # global pool + flatten in one layer
```

`Rearrange`/`Reduce` are identical to the functions but as `nn.Module`s — same patterns,
keyword axis lengths in the constructor. Prefer them over `forward`-method reshapes so the
model stays a printable/savable/sliceable `Sequential`.

Utilities: `parse_shape(x, "b c h w")` → dict of axis sizes (skip with `_`), for re-inserting
shapes elsewhere; `einops.asnumpy(x)` → numpy array (pulls off GPU if needed).

## Rewrite principles

- Replace `.view` / `.reshape` / `.permute` / `.transpose` / `.contiguous` / `.squeeze` /
  `.unsqueeze` chains with one einops call — the named axes *are* the documentation.
- Explicit axis names and lengths beat magic dims (`-1`, hard-coded `320`): einops raises a
  clear error on unexpected input instead of reshaping into nonsense.
- Add a leading/trailing identity `rearrange` to document expected I/O layout; change the
  interface by editing one pattern (`"t b -> t b"` → `"b t -> t b"`).
- **Split order matters.** `(c split)` interleaves; `(split c)` takes contiguous halves.
  This bites GLU, bidirectional LSTM/RNN outputs, group convs, and multi-head splits — make
  the split explicit so the intent is checkable.

## Worked rewrites

### ConvNet — flatten as a layer, drop the stateful `forward`

```python
# old: a class whose forward hides a magic `x.view(-1, 320)` (silently wrong on resize)
class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1, self.conv2 = nn.Conv2d(1, 10, 5), nn.Conv2d(10, 20, 5)
        self.conv2_drop = nn.Dropout2d()
        self.fc1, self.fc2 = nn.Linear(320, 50), nn.Linear(50, 10)
    def forward(self, x):
        x = F.relu(F.max_pool2d(self.conv1(x), 2))
        x = F.relu(F.max_pool2d(self.conv2_drop(self.conv2(x)), 2))
        x = x.view(-1, 320)
        x = F.relu(self.fc1(x))
        x = F.dropout(x, training=self.training)
        return F.log_softmax(self.fc2(x), dim=1)

# new: plain Sequential — printable, sliceable (conv_net[:-1]), dropout-flag-safe
conv_net = nn.Sequential(
    nn.Conv2d(1, 10, kernel_size=5), nn.MaxPool2d(2), nn.ReLU(),
    nn.Conv2d(10, 20, kernel_size=5), nn.MaxPool2d(2), nn.ReLU(),
    nn.Dropout2d(),
    Rearrange("b c h w -> b (c h w)"),     # raises on unexpected shape instead of mangling it
    nn.Linear(320, 50), nn.ReLU(), nn.Dropout(),
    nn.Linear(50, 10), nn.LogSoftmax(dim=1),
)
```

### Gram matrix — einsum over a reshape+bmm

```python
# old
def gram_matrix(y):
    b, ch, h, w = y.size()
    features = y.view(b, ch, w * h)
    return features.bmm(features.transpose(1, 2)) / (ch * h * w)

# new — the input layout is stated in the contraction itself
def gram_matrix(y):
    b, ch, h, w = y.shape
    return torch.einsum("bchw,bdhw->bcd", [y, y]) / (h * w)
```

### ResNet — `Reduce` for avgpool+flatten, no internal state

```python
def make_layer(inplanes, planes, block, n_blocks, stride=1):
    downsample = None
    if stride != 1 or inplanes != planes * block.expansion:
        downsample = nn.Sequential(
            nn.Conv2d(inplanes, planes * block.expansion, 1, stride=stride, bias=False),
            nn.BatchNorm2d(planes * block.expansion),
        )
    return nn.Sequential(
        block(inplanes, planes, stride, downsample),
        *[block(planes * block.expansion, planes) for _ in range(1, n_blocks)],
    )

def ResNet(block, layers, num_classes=1000):
    e = block.expansion
    return nn.Sequential(
        Rearrange("b c h w -> b c h w", c=3, h=224, w=224),   # explicit input contract
        nn.Conv2d(3, 64, kernel_size=7, stride=2, padding=3, bias=False),
        nn.BatchNorm2d(64), nn.ReLU(inplace=True),
        nn.MaxPool2d(kernel_size=3, stride=2, padding=1),
        make_layer(64,      64,  block, layers[0], stride=1),
        make_layer(64 * e,  128, block, layers[1], stride=2),
        make_layer(128 * e, 256, block, layers[2], stride=2),
        make_layer(256 * e, 512, block, layers[3], stride=2),
        Reduce("b c h w -> b c", "mean"),                     # avgpool + flatten in one op
        nn.Linear(512 * e, num_classes),
    )
```

### Attention — heads via `rearrange`, scores via `einsum`

```python
# simple attention: contraction order reads off the axis names
def attention(K, V, Q):
    _, n_channels, _ = K.shape
    A = torch.einsum("bct,bcl->btl", [K, Q])
    A = F.softmax(A * n_channels ** (-0.5), dim=1)
    R = torch.einsum("bct,btl->bcl", [V, A])
    return torch.cat((R, Q), dim=1)

# transformer multi-head: split heads in, merge heads out — one module, mask-safe
class MultiHeadAttention(nn.Module):
    def forward(self, q, k, v, mask=None):
        residual = q
        q = rearrange(self.w_qs(q), "b l (head k) -> head b l k", head=self.n_head)
        k = rearrange(self.w_ks(k), "b t (head k) -> head b t k", head=self.n_head)
        v = rearrange(self.w_vs(v), "b t (head v) -> head b t v", head=self.n_head)
        attn = torch.einsum("hblk,hbtk->hblt", [q, k]) / np.sqrt(q.shape[-1])
        if mask is not None:
            attn = attn.masked_fill(mask[None], -np.inf)
        attn = torch.softmax(attn, dim=3)
        output = torch.einsum("hblt,hbtv->hblv", [attn, v])
        output = rearrange(output, "head b l v -> b l (head v)")
        output = self.layer_norm(self.dropout(self.fc(output)) + residual)
        return output, attn
```

### Image grid — tile a batch with one pattern

```python
padded = F.pad(fake_batch[:64], [1, 1, 1, 1])
plt.imshow(rearrange(padded, "(b1 b2) c h w -> (b1 h) (b2 w) c", b1=8).cpu())
```
