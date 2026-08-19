# -*- coding: utf-8 -*-
"""词影迷踪 · 词库生成脚本

读取同目录 wordbank.txt（每行「分类|词1 词2 词3* …」，
词尾带 * 表示难词），去重、校验，生成 game.js 中的 WORD_BANK 代码块，
并替换 game.js 第 12–3013 行的旧词库。运行前会自动备份 game.js。

用法：
    python tools/build_wordbank.py            # 生成并写回
    python tools/build_wordbank.py --check    # 仅校验，不写回
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "tools", "wordbank.txt")
GAME_JS = os.path.join(ROOT, "game.js")
TARGET = 4818

START_MARK = "const WORD_BANK = Array.from(new Map(["
END_MARK = "].map((item) => [item.word, item])).values());"

# 难词集合：具体但相对冷门、较难给出提示的词（非专业、非抽象）
HARD = {
    # 动物
    "藏羚羊", "雪豹", "云豹", "山魈", "独角仙", "竹节虫", "金龟子", "天牛",
    "信天翁", "鹈鹕", "鹌鹑", "丹顶鹤", "火烈鸟", "蜂鸟", "娃娃鱼", "响尾蛇",
    "变色龙", "金丝猴", "长臂猿", "麋鹿", "牦牛", "眼镜蛇",
    # 植物
    "红杉", "白桦", "香樟", "龟背竹", "富贵竹", "捕蝇草", "猪笼草", "含羞草",
    "迷迭香", "棕榈树", "蕨类",
    # 水果
    "莲雾", "番石榴", "红毛丹", "人参果", "椰枣", "血橙", "沃柑", "灯笼果",
    "姑娘果", "沙棘", "蛇果", "佛手",
    # 蔬菜
    "荸荠", "茭白", "慈姑", "蕨菜", "马齿苋", "香椿", "荠菜", "冬笋", "春笋", "蒜苔",
    # 食物
    "煲仔饭", "驴肉火烧", "蟹黄包", "莲蓉包", "千层饼", "锅盔", "杂粮煎饼",
    "糍粑", "青团", "米糕", "发糕",
    # 天文气象
    "日晷", "极光", "流星雨", "启明星", "上弦月", "下弦月", "霜冻", "晨雾",
    "鹅毛雪", "雷阵雨",
    # 地理自然
    "三角洲", "钟乳石", "石笋", "天坑", "溶洞", "暗礁", "盐湖", "冻土", "苔原", "冰原",
    # 人体
    "太阳穴", "锁骨", "脊椎", "骨盆", "肚脐", "腋下", "指纹", "掌纹", "脚后跟",
    # 健康
    "听诊器", "创可贴", "止咳糖浆", "针灸", "拔罐", "推拿", "艾灸", "碘伏", "血压计",
    # 家居
    "五斗柜", "樟脑丸", "电蚊拍", "置物架", "蒲团", "蚊帐", "落地灯", "床头柜",
    # 厨房
    "破壁机", "空气炸锅", "电压力锅", "砧板", "擀面杖", "高压锅", "电饼铛",
    # 电器
    "除螨仪", "电陶炉", "挂烫机", "空气净化器", "扫地机器人", "直发器",
    # 服饰
    "贝雷帽", "连裤袜", "背带裤", "工装裤", "冲锋衣", "雪地靴", "腰包", "袖套",
    # 交通
    "磁悬浮", "顺风车", "油罐车", "叉车", "压路机", "皮划艇", "滑翔机", "热气球",
    # 城市建筑
    "摩天大楼", "卷帘门", "采光井", "窨井", "盲道", "消防栓", "母婴室", "无障碍通道",
    # 学校
    "答题卡", "教辅", "重修", "学分", "答辩", "开题", "录取", "志愿",
    # 职业
    "兽医", "公证员", "仲裁员", "报关员", "驯兽师", "饲养员", "品控", "法务",
    # 体育
    "撑杆跳", "三级跳", "链球", "冰壶", "钢架雪车", "藤球", "毽球", "花样滑冰",
    "短道速滑", "单板滑雪",
    # 音乐
    "五线谱", "简谱", "尤克里里", "定音鼓", "手风琴", "单簧管", "双簧管", "圆号", "颤音", "假声",
    # 影视娱乐
    "花絮", "彩蛋", "预告片", "影帝", "影后", "金鸡奖", "金像奖", "金马奖", "脱口秀", "黄梅戏", "越剧",
    # 游戏玩具
    "十连抽", "保底", "消消乐", "俄罗斯方块", "贪吃蛇", "三国杀", "狼人杀", "剧本杀", "密室逃脱",
    # 数码科技
    "固态硬盘", "读卡器", "蓝牙耳机", "无人机", "三脚架", "快门", "微单", "传感器",
    "人脸识别", "指纹识别",
    # 网络
    "弹幕", "站姐", "同人文", "二刷", "三刷", "种草", "拔草", "剁手", "名场面", "前方高能", "完结撒花",
    # 职场
    "斜杠青年", "社畜", "内卷", "摸鱼", "带薪", "007", "996", "大小周", "弹性工作", "远程办公",
    # 商业
    "代金券", "提货券", "消费券", "保税仓", "海淘", "转运", "直营", "加盟", "连锁", "三包",
    # 情感
    "腼腆", "木讷", "迟钝", "伶俐", "憨厚", "倔强", "固执", "执着", "怯懦", "豁达",
    # 动作
    "踉跄", "蹒跚", "踮脚", "耸肩", "挑眉", "撇嘴", "皱眉", "眨眼", "打盹", "哈欠",
    # 文具工具
    "游标卡尺", "电烙铁", "热熔胶", "起钉器", "描红本", "字帖", "复写纸", "水平尺",
    # 颜色
    "藏青色", "湖蓝色", "藕荷", "藕粉", "酒红色", "枣红色", "砖红色", "卡其色", "驼色", "军绿色",
    # 时间
    "拂晓", "破晓", "凌晨", "午夜", "子夜", "时辰", "纪元", "农历", "日晷",
    # 旅游
    "浮潜", "溯溪", "青旅", "背包客", "玻璃栈道", "摆渡车", "观光车", "转机", "经停",
    # 艺术手工
    "工笔画", "篆刻", "拓印", "装裱", "过塑", "手账", "火漆", "封蜡", "裱画",
    # 形状计量
    "棱锥", "圆台", "棱柱", "截面", "剖面", "对角线", "垂直", "平行", "对称", "参差",
    # 自然元素
    "石英", "石墨", "硫磺", "硝石", "焦炭", "沥青", "铂金", "玛瑙", "琥珀", "珊瑚",
    # 传统文化
    "貔貅", "饕餮", "獬豸", "白泽", "鲲鹏", "金乌", "编磬", "瓦当", "鸱吻", "藻井", "斗拱", "编钟",
}


def parse():
    words = []          # list of (word, category, difficulty)
    seen = set()
    dup = []
    hard = []
    if not os.path.exists(DATA):
        sys.exit(f"找不到数据文件：{DATA}")
    with open(DATA, "r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "|" not in line:
                sys.exit(f"第 {lineno} 行缺少分隔符 |：{line}")
            category, rest = line.split("|", 1)
            category = category.strip()
            for token in rest.split():
                token = token.strip()
                if not token:
                    continue
                is_hard = token.endswith("*")
                word = token[:-1] if is_hard else token
                if not re.fullmatch(r"[一-鿿A-Za-z0-9·]{2,8}", word):
                    sys.exit(f"第 {lineno} 行含非法词：{word!r}")
                if word in seen:
                    dup.append(word)
                    continue
                seen.add(word)
                difficulty = "hard" if (is_hard or word in HARD) else "normal"
                words.append((word, category, difficulty))
                if is_hard or word in HARD:
                    hard.append(word)
    return words, dup, hard


def report(words, dup, hard):
    print(f"总词数：{len(words)}  (目标 {TARGET})")
    print(f"难词数：{len(hard)}")
    if dup:
        print(f"!! 重复词 {len(dup)} 个（已丢弃）：{'、'.join(dup)}")
    cats = {}
    for _, c, _ in words:
        cats[c] = cats.get(c, 0) + 1
    print(f"分类数：{len(cats)}")
    for c, n in sorted(cats.items(), key=lambda x: -x[1]):
        print(f"  {c}: {n}")


def emit(words):
    lines = [START_MARK]
    for word, category, difficulty in words:
        lines.append(f"  {{ word: '{word}', category: '{category}', difficulty: '{difficulty}' }},")
    lines.append(END_MARK)
    return "\n".join(lines) + "\n"


def rewrite(block):
    with open(GAME_JS, "r", encoding="utf-8") as f:
        src = f.read()
    start = src.index(START_MARK)
    end = src.index(END_MARK, start) + len(END_MARK)
    assert src.count(START_MARK) == 1, "存在多个词库起始标记"
    bak = GAME_JS + ".bak"
    if not os.path.exists(bak):
        with open(bak, "w", encoding="utf-8") as f:
            f.write(src)
    with open(GAME_JS, "w", encoding="utf-8") as f:
        f.write(src[:start] + block + src[end:])
    print(f"已写回 {GAME_JS}（备份 {bak}）")


def main():
    words, dup, hard = parse()
    report(words, dup, hard)
    if len(words) != TARGET:
        print(f"!! 数量不符：{len(words)} != {TARGET}，请调整数据")
    if "--check" not in sys.argv:
        rewrite(emit(words))
        print("完成。")


if __name__ == "__main__":
    main()
