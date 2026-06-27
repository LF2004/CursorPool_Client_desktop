#!/usr/bin/env python3
"""
cursor-extract-proto.py  v2
从 Cursor 客户端的 workbench.desktop.main.js 提取 protobuf 定义，生成 .proto 文件。

v2 改进：用括号匹配替代正则提取 fields（正则在46MB文件中不可靠），字段属性顺序无关解析，去重。

用法:
  python cursor-extract-proto.py <workbench.desktop.main.js路径> <输出目录>
"""
import sys, os, re, json
from collections import defaultdict

# ── protobuf 标量类型表 ──
SCALAR_TYPES = {
    1: "double", 2: "float", 3: "int64", 4: "uint64",
    5: "int32", 6: "fixed64", 7: "fixed32", 8: "bool",
    9: "string", 12: "bytes", 13: "uint32",
    15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64",
}

METHOD_KINDS = {
    "Unary": "unary", "ServerStreaming": "server_streaming",
    "ClientStreaming": "client_streaming", "BiDiStreaming": "bidi_streaming",
}

# ═══════════════════════════════════════════════════════════════
#  括号匹配提取器（核心，比正则可靠）
# ═══════════════════════════════════════════════════════════════

def extract_bracket_content(src, start_pos, open_char='[', close_char=']'):
    """从 start_pos 开始找第一个 open_char，用括号匹配提取到对应 close_char 的内容。
    返回 (内容, 结束位置) 或 (None, -1)。"""
    i = src.find(open_char, start_pos)
    if i < 0:
        return None, -1
    start = i  # 保存 open_char 的位置
    depth = 0
    while i < len(src):
        c = src[i]
        if c == open_char:
            depth += 1
        elif c == close_char:
            depth -= 1
            if depth == 0:
                return src[start + 1:i], i + 1  # 返回括号内的内容
        i += 1
    return None, -1


def split_fields(fields_str):
    """把 fields 数组内容按顶层花括号分成一个个字段字符串。
    例: '{no:1,...},{no:2,...}' -> ['{no:1,...}', '{no:2,...}']"""
    result = []
    i = 0
    n = len(fields_str)
    while i < n:
        # 找下一个 {
        brace_start = fields_str.find('{', i)
        if brace_start < 0:
            break
        # 括号匹配找对应的 }
        depth = 0
        j = brace_start
        while j < n:
            c = fields_str[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    result.append(fields_str[brace_start:j + 1])
                    i = j + 1
                    break
            j += 1
        else:
            break
    return result


def parse_field(field_str):
    """解析单个字段字符串，顺序无关。返回 dict 或 None。"""
    no_m = re.search(r'no:(\d+)', field_str)
    name_m = re.search(r'name:"([^"]+)"', field_str)
    kind_m = re.search(r'kind:"([^"]+)"', field_str)
    if not no_m or not name_m or not kind_m:
        return None

    # T 可能是: 数字(标量)、变量名(message)、getEnumType(VAR)(enum)
    t_raw = None
    t_m = re.search(r'T:([^,}\s]+)', field_str)
    if t_m:
        t_raw = t_m.group(1)

    opt = 'opt:!0' in field_str
    repeated = 'repeated:!0' in field_str
    oneof_m = re.search(r'oneof:"([^"]*)"', field_str)
    oneof = oneof_m.group(1) if oneof_m else ""

    # map 类型特殊处理: kind:"map",K:{...},V:{...}
    if kind_m.group(1) == "map":
        k_m = re.search(r'K:\{keyType:(\d+)', field_str)
        v_m = re.search(r'V:\{type:(\w+)', field_str)
        return {
            'no': int(no_m.group(1)),
            'name': name_m.group(1),
            'kind': 'map',
            't': t_raw,
            'opt': opt,
            'repeated': repeated,
            'oneof': oneof,
            'map_key_type': k_m.group(1) if k_m else None,
            'map_value_var': v_m.group(1) if v_m else None,
        }

    return {
        'no': int(no_m.group(1)),
        'name': name_m.group(1),
        'kind': kind_m.group(1),
        't': t_raw,
        'opt': opt,
        'repeated': repeated,
        'oneof': oneof,
    }


# ═══════════════════════════════════════════════════════════════
#  数据结构
# ═══════════════════════════════════════════════════════════════

class ProtoField:
    def __init__(self, d):
        self.no = d['no']
        self.name = d['name']
        self.kind = d['kind']
        self.t = d.get('t')
        self.opt = d.get('opt', False)
        self.repeated = d.get('repeated', False)
        self.oneof = d.get('oneof', '')
        self.resolved_type = None
        self.map_key_type = d.get('map_key_type')
        self.map_value_var = d.get('map_value_var')

class ProtoMessage:
    def __init__(self, type_name, var_name):
        self.type_name = type_name
        self.var_name = var_name
        self.fields = []
        self.fields_by_no = {}  # 去重
        self.package = ".".join(type_name.split(".")[:-1])
        self.short_name = type_name.split(".")[-1]

    def add_field(self, d):
        f = ProtoField(d)
        if f.no not in self.fields_by_no:
            self.fields_by_no[f.no] = f
            self.fields.append(f)

class ProtoEnum:
    def __init__(self, type_name, var_name):
        self.type_name = type_name
        self.var_name = var_name
        self.values = []
        self.values_by_no = {}
        self.package = ".".join(type_name.split(".")[:-1])
        self.short_name = type_name.split(".")[-1]

    def add_value(self, no, name):
        if no not in self.values_by_no:
            self.values_by_no[no] = name
            self.values.append((no, name))

class ProtoService:
    def __init__(self, type_name):
        self.type_name = type_name
        self.methods = []
        self.methods_by_name = {}
        self.package = ".".join(type_name.split(".")[:-1])
        self.short_name = type_name.split(".")[-1]

    def add_method(self, js_name, pascal, i_var, o_var, kind):
        if js_name not in self.methods_by_name:
            self.methods_by_name[js_name] = True
            self.methods.append((js_name, pascal, i_var, o_var, kind))


# ═══════════════════════════════════════════════════════════════
#  提取主流程
# ═══════════════════════════════════════════════════════════════

# typeName 正则 — 两种模式
RE_TYPENAME_A = re.compile(r'(\w+)\.typeName="([a-z0-9_]+\.[a-z0-9_]+\.[A-Za-z0-9_]+)"')
RE_TYPENAME_B = re.compile(r'w\((\w+),"typeName","([a-z0-9_]+\.[a-z0-9_]+\.[A-Za-z0-9_]+)"\)')

# setEnumType 正则 — 只提取 VAR 和 typeName，values 用括号匹配
RE_SET_ENUM = re.compile(r'setEnumType\((\w+),"([a-z0-9_]+\.[a-z0-9_]+\.[A-Za-z0-9_]+)",')

# enum value 正则
RE_ENUM_VAL = re.compile(r'\{no:(\d+),name:"([A-Za-z0-9_]+)"\}')

# service 正则 — 不包含最后的 {，让 extract_bracket_content 自己找
RE_SERVICE_START = re.compile(r'\{typeName:"([a-z0-9_]+\.[a-z0-9_]+\.[A-Za-z0-9_]+)",methods:')

# method 正则
RE_METHOD = re.compile(r'(\w+):\{name:"([^"]+)",I:(\w+),O:(\w+),kind:rt\.(\w+)\}')

# newFieldList 位置标记 — 找到后用括号匹配提取内容
RE_FIELDLIST_POS_A = re.compile(r'(\w+)\.fields=(\w+)\.util\.newFieldList\(')
RE_FIELDLIST_POS_B = re.compile(r'w\((\w+),"fields",(\w+)\.util\.newFieldList\(')


def extract_all(src_text):
    messages = {}
    enums = {}
    services = {}
    var_to_type = {}

    # ── 第1步: 收集所有 typeName 建立 var_to_type ──
    for m in RE_TYPENAME_A.finditer(src_text):
        var_to_type[m.group(1)] = m.group(2)
    for m in RE_TYPENAME_B.finditer(src_text):
        var_to_type[m.group(1)] = m.group(2)
    print(f"  [1/6] var_to_type 映射: {len(var_to_type)} 条")

    # ── 第1.5步: 解析变量别名（JS 压缩后同一类有多个变量名）──
    # 扫描 VAR1=VAR2 模式，若 VAR2 已知则 VAR1 也映射到同一 typeName
    # 迭代到收敛
    RE_ALIAS = re.compile(r'[,;}{()\n]\s*(\w+)=(\w+)(?=[,;)}\n])')
    for iteration in range(5):  # 最多迭代5轮
        added = 0
        for m in RE_ALIAS.finditer(src_text):
            alias_var, target_var = m.group(1), m.group(2)
            if target_var in var_to_type and alias_var not in var_to_type:
                var_to_type[alias_var] = var_to_type[target_var]
                added += 1
        if added == 0:
            break
    print(f"  [1.5/6] 别名解析后 var_to_type: {len(var_to_type)} 条")

    # ── 第2步: 收集 enum 定义 ──
    for m in RE_SET_ENUM.finditer(src_text):
        var_name, type_name = m.group(1), m.group(2)
        e = enums.setdefault(type_name, ProtoEnum(type_name, var_name))
        # 用括号匹配提取 enum values 数组
        vals_str, _ = extract_bracket_content(src_text, m.end(), '[', ']')
        if vals_str:
            for vm in RE_ENUM_VAL.finditer(vals_str):
                e.add_value(int(vm.group(1)), vm.group(2))
        var_to_type[var_name] = type_name
    print(f"  [2/6] enum 定义: {len(enums)} 个")

    # ── 第3步: 创建 message 对象 (排除 enum) ──
    # 同时记录每个 typeName 出现的位置，用于后续按位置关联 fields
    type_name_positions = []  # [(position, var_name, type_name)]
    for m in RE_TYPENAME_A.finditer(src_text):
        var_name, type_name = m.group(1), m.group(2)
        if type_name not in enums:
            messages.setdefault(type_name, ProtoMessage(type_name, var_name))
            type_name_positions.append((m.start(), var_name, type_name))
    for m in RE_TYPENAME_B.finditer(src_text):
        var_name, type_name = m.group(1), m.group(2)
        if type_name not in enums:
            messages.setdefault(type_name, ProtoMessage(type_name, var_name))
            type_name_positions.append((m.start(), var_name, type_name))
    print(f"  [3/6] message 定义: {len(messages)} 个, 位置记录: {len(type_name_positions)} 条")

    # ── 第4步: 按位置关联提取 fields ──
    # 对每个 typeName 位置，在其后方 8000 字符内找 .fields= 或 w(VAR,"fields",
    # 这样避免 JS 变量名复用导致不同 message 的 fields 被混淆
    fields_parsed = 0
    SEARCH_WINDOW = 8000  # typeName 到 fields 定义的最大距离
    for pos, var_name, type_name in type_name_positions:
        if type_name not in messages:
            continue
        msg = messages[type_name]
        # 在 pos 到 pos+SEARCH_WINDOW 范围内找 fields 定义
        search_region = src_text[pos:pos + SEARCH_WINDOW]
        # 模式A: VAR.fields=RUNTIME.util.newFieldList(
        pat_a = re.compile(re.escape(var_name) + r'\.fields=(\w+)\.util\.newFieldList\(')
        # 模式B: w(VAR,"fields",RUNTIME.util.newFieldList(
        pat_b = re.compile(r'w\(' + re.escape(var_name) + r',"fields",(\w+)\.util\.newFieldList\(')
        found = False
        for pat in [pat_a, pat_b]:
            m = pat.search(search_region)
            if m:
                abs_pos = pos + m.end()
                fields_str, _ = extract_bracket_content(src_text, abs_pos, '[', ']')
                if fields_str:
                    for field_str in split_fields(fields_str):
                        d = parse_field(field_str)
                        if d:
                            msg.add_field(d)
                            fields_parsed += 1
                found = True
                break  # 只取第一个匹配
    for msg in messages.values():
        msg.fields.sort(key=lambda f: f.no)
    print(f"  [4/6] fields 解析: {fields_parsed} 个字段")

    # ── 第5步: 收集 service 定义 ──
    for m in RE_SERVICE_START.finditer(src_text):
        type_name = m.group(1)
        svc = services.setdefault(type_name, ProtoService(type_name))
        # 用括号匹配提取 methods:{...} 的内容
        methods_str, _ = extract_bracket_content(src_text, m.end(), '{', '}')
        if methods_str:
            for mm in RE_METHOD.finditer(methods_str):
                svc.add_method(mm.group(1), mm.group(2), mm.group(3), mm.group(4), mm.group(5))
    print(f"  [5/6] service 定义: {len(services)} 个")

    # ── 第6步: 解析类型引用 ──
    def resolve_type(t_raw, kind):
        if not t_raw:
            return None
        if kind == "scalar":
            try:
                return SCALAR_TYPES.get(int(t_raw), f"/* unknown scalar {t_raw} */")
            except ValueError:
                return None
        elif kind == "enum":
            t_clean = t_raw.replace("getEnumType(", "").rstrip(")")
            return var_to_type.get(t_clean, f"/* unresolved enum {t_raw} */")
        elif kind == "message":
            return var_to_type.get(t_raw, f"/* unresolved {t_raw} */")
        return None

    for msg in messages.values():
        for f in msg.fields:
            f.resolved_type = resolve_type(f.t, f.kind)

    for svc in services.values():
        svc.resolved_methods = []
        for js_name, pascal, i_var, o_var, kind in svc.methods:
            i_type = var_to_type.get(i_var, f"/* unresolved {i_var} */")
            o_type = var_to_type.get(o_var, f"/* unresolved {o_var} */")
            svc.resolved_methods.append((js_name, pascal, i_type, o_type, kind))

    print(f"  [6/6] 类型引用解析完成")
    return messages, enums, services, var_to_type


# ═══════════════════════════════════════════════════════════════
#  跨包引用处理
# ═══════════════════════════════════════════════════════════════

def collect_refs(type_name, messages, enums, needed, local_types, visited):
    if type_name in visited or type_name in local_types:
        return
    visited.add(type_name)
    if type_name in enums:
        needed.add(type_name)
        return
    if type_name in messages:
        needed.add(type_name)
        for f in messages[type_name].fields:
            if f.kind in ("message", "enum") and f.resolved_type and not f.resolved_type.startswith("/*"):
                collect_refs(f.resolved_type, messages, enums, needed, local_types, visited)


# ═══════════════════════════════════════════════════════════════
#  .proto 文件生成
# ═══════════════════════════════════════════════════════════════

def type_to_proto(type_name, current_pkg):
    parts = type_name.split(".")
    pkg = ".".join(parts[:-1])
    short = parts[-1]
    if pkg == current_pkg:
        return short
    return "." + type_name

def gen_enum(e, current_pkg):
    lines = [f"enum {e.short_name} {{"]
    for no, name in e.values:
        lines.append(f"  {name} = {no};")
    lines.append("}")
    return "\n".join(lines)

def gen_field_line(f, current_pkg, indent):
    pad = "  " * indent
    if f.kind == "scalar":
        proto_type = f.resolved_type or "string"
    elif f.kind == "message":
        if not f.resolved_type or f.resolved_type.startswith("/*"):
            return None
        proto_type = type_to_proto(f.resolved_type, current_pkg)
    elif f.kind == "enum":
        if not f.resolved_type or f.resolved_type.startswith("/*"):
            return None
        proto_type = type_to_proto(f.resolved_type, current_pkg)
    elif f.kind == "map":
        # map<key_type, value_type>
        key = SCALAR_TYPES.get(int(f.map_key_type), "string") if f.map_key_type else "string"
        val = f.resolved_type or "string"
        prefix = ""  # map 本身就是 repeated
        return f"{pad}map<{key}, {val}> {f.name} = {f.no};"
    else:
        return None

    prefix = "repeated " if f.repeated else ""
    opt = "optional " if f.opt else ""
    return f"{pad}{prefix}{opt}{proto_type} {f.name} = {f.no};"

def gen_message(msg, current_pkg, indent=0):
    pad = "  " * indent
    lines = [f"{pad}message {msg.short_name} {{"]

    oneof_groups = defaultdict(list)
    regular_fields = []
    for f in msg.fields:
        if f.oneof:
            oneof_groups[f.oneof].append(f)
        else:
            regular_fields.append(f)

    for f in regular_fields:
        line = gen_field_line(f, current_pkg, indent + 1)
        if line:
            lines.append(line)

    for oneof_name, fields in oneof_groups.items():
        fields.sort(key=lambda f: f.no)
        opad = "  " * (indent + 1)
        lines.append(f"{opad}oneof {oneof_name} {{")
        for f in fields:
            line = gen_field_line(f, current_pkg, indent + 2)
            if line:
                lines.append(line)
        lines.append(f"{opad}}}")

    lines.append(f"{pad}}}")
    return "\n".join(lines)

def gen_service(svc, current_pkg):
    lines = [f"service {svc.short_name} {{"]
    for js_name, pascal, i_type, o_type, kind in svc.resolved_methods:
        # 跳过未解析的 I/O 类型
        if i_type.startswith("/*") or o_type.startswith("/*"):
            lines.append(f"  // rpc {pascal}(/* unresolved */);")
            continue
        i_proto = type_to_proto(i_type, current_pkg)
        o_proto = type_to_proto(o_type, current_pkg)
        method_kind = METHOD_KINDS.get(kind, "unary")
        if method_kind in ("server_streaming", "bidi_streaming"):
            lines.append(f"  rpc {pascal}({i_proto}) returns (stream {o_proto});")
        elif method_kind == "client_streaming":
            lines.append(f"  rpc {pascal}(stream {i_proto}) returns ({o_proto});")
        else:
            lines.append(f"  rpc {pascal}({i_proto}) returns ({o_proto});")
    lines.append("}")
    return "\n".join(lines)

def generate_proto_files(messages, enums, services, out_dir):
    pkg_messages = defaultdict(list)
    pkg_enums = defaultdict(list)
    pkg_services = defaultdict(list)

    for msg in messages.values():
        pkg_messages[msg.package].append(msg)
    for e in enums.values():
        pkg_enums[e.package].append(e)
    for svc in services.values():
        pkg_services[svc.package].append(svc)

    all_pkgs = sorted(set(list(pkg_messages.keys()) + list(pkg_enums.keys()) + list(pkg_services.keys())))
    os.makedirs(out_dir, exist_ok=True)

    stats = {"packages": 0, "messages": 0, "enums": 0, "services": 0, "files": []}

    for pkg in all_pkgs:
        if pkg in ("google.protobuf", "google.rpc"):
            continue  # protobufjs 自带
        local_types = set()
        for msg in pkg_messages.get(pkg, []):
            local_types.add(msg.type_name)
        for e in pkg_enums.get(pkg, []):
            local_types.add(e.type_name)

        # 不复制跨包类型 — protobufjs 加载所有文件后 resolveAll() 自动解析全名引用
        # 这样避免重复定义冲突
        needed_external = set()  # 保留收集逻辑但不生成复制代码

        lines = [
            'syntax = "proto3";', "",
            f"package {pkg};", "",
            'import "google/protobuf/struct.proto";',
            'import "google/protobuf/empty.proto";',
            'import "google/protobuf/timestamp.proto";',
            'import "google/protobuf/duration.proto";',
            'import "google/protobuf/wrappers.proto";',
            'import "google/protobuf/any.proto";',
            'import "google/protobuf/field_mask.proto";',
            "",
        ]

        for e in sorted(pkg_enums.get(pkg, []), key=lambda x: x.short_name):
            lines.append(gen_enum(e, pkg))
            lines.append("")
            stats["enums"] += 1

        for msg in sorted(pkg_messages.get(pkg, []), key=lambda x: x.short_name):
            lines.append(gen_message(msg, pkg))
            lines.append("")
            stats["messages"] += 1

        for svc in sorted(pkg_services.get(pkg, []), key=lambda x: x.short_name):
            lines.append(gen_service(svc, pkg))
            lines.append("")
            stats["services"] += 1

        if needed_external:
            lines.append("// ═══ 跨包引用类型（复制以避免循环导入）═══")
            lines.append("")
            for t in sorted(needed_external):
                if t in enums:
                    e = enums[t]
                    lines.append(f"// Copied from: {e.type_name}")
                    lines.append(gen_enum(e, pkg))
                    lines.append("")
                elif t in messages:
                    msg = messages[t]
                    lines.append(f"// Copied from: {msg.type_name}")
                    lines.append(gen_message(msg, pkg))
                    lines.append("")

        fname = pkg.replace(".", "_") + ".proto"
        fpath = os.path.join(out_dir, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        stats["files"].append(fname)
        stats["packages"] += 1
        print(f"  生成 {fname}: {len(pkg_messages.get(pkg, []))} msg, {len(pkg_enums.get(pkg, []))} enum, {len(pkg_services.get(pkg, []))} svc, {len(needed_external)} 外部类型")

    stats_path = os.path.join(out_dir, "_extraction_stats.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    return stats


# ═══════════════════════════════════════════════════════════════
#  主入口
# ═══════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 3:
        print("用法: python cursor-extract-proto.py <workbench.desktop.main.js> <输出目录>")
        sys.exit(1)

    src_path, out_dir = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src_path):
        print(f"错误: 源文件不存在: {src_path}")
        sys.exit(1)

    print(f"读取源文件: {src_path}")
    with open(src_path, "r", encoding="utf-8", errors="replace") as f:
        src_text = f.read()
    print(f"  文件大小: {len(src_text) / 1024 / 1024:.1f} MB")

    print("提取 proto 定义...")
    messages, enums, services, var_to_type = extract_all(src_text)

    all_pkgs = sorted(set(
        [m.package for m in messages.values()] +
        [e.package for e in enums.values()] +
        [s.package for s in services.values()]
    ))
    # 跳过 google.protobuf / google.rpc — protobufjs 自带这些类型
    all_pkgs = [p for p in all_pkgs if p not in ("google.protobuf", "google.rpc")]
    print(f"\n发现 {len(all_pkgs)} 个 package:")
    for p in all_pkgs:
        mc = sum(1 for m in messages.values() if m.package == p)
        ec = sum(1 for e in enums.values() if e.package == p)
        sc = sum(1 for s in services.values() if s.package == p)
        print(f"  {p}: {mc} msg, {ec} enum, {sc} svc")

    print(f"\n生成 .proto 文件到: {out_dir}")
    stats = generate_proto_files(messages, enums, services, out_dir)
    print(f"\n✅ 完成! {stats['packages']} 包, {stats['messages']} msg, {stats['enums']} enum, {stats['services']} svc")
    print(f"   文件: {', '.join(stats['files'])}")


if __name__ == "__main__":
    main()
