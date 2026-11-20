"""Cell-count measurements and explicitly approximate volume-based estimates."""
from datetime import datetime
from decimal import Decimal, DecimalException
import re
from zoneinfo import ZoneInfo
from medium import number, text

TZ=ZoneInfo('Asia/Shanghai')
KEYS={'mode','coefficient','exponent','unit','volume_value','volume_unit','measured_at'}


def normalize_count(value,well,now=None):
    if isinstance(value,dict) and set(value)=={'clear'} and value['clear'] is True:return None
    if not isinstance(value,dict) or set(value)-KEYS:
        raise ValueError('细胞计数格式不正确')
    mode=value.get('mode')
    if mode not in ['concentration','total']:raise ValueError('请选择浓度或总细胞数')
    coefficient=number(value.get('coefficient',''),'计数数值')
    exponent=text(value.get('exponent',''),'10的指数',12)
    unit=text(value.get('unit',''),'计数单位',100)
    if not coefficient or not re.fullmatch(r'[+-]?\d+',exponent) or not unit:
        raise ValueError('请填写计数数值、整数指数和单位')
    exponent=str(int(exponent))
    volume=number(value.get('volume_value',''),'培养基大致体积')
    volume_unit=text(value.get('volume_unit',''),'体积单位',100)
    if mode=='total':volume=volume_unit=''
    if volume and not volume_unit:raise ValueError('填写体积时需同时填写体积单位')
    measured=text(value.get('measured_at',''),'计数时间',40)
    try:parsed=datetime.fromisoformat(measured)
    except ValueError:raise ValueError('请填写有效计数时间') from None
    if parsed.tzinfo is not None:raise ValueError('计数时间请使用北京时间，不附加其他时区')
    now=now or datetime.now(TZ)
    if parsed.replace(tzinfo=TZ)>now:raise ValueError('计数时间不能在未来')
    if (well.get('day0') and parsed.date().isoformat()<well['day0']) or (well.get('introduced_at') and datetime.fromisoformat(well['introduced_at'])>parsed):
        raise ValueError('计数时间不能早于该培养记录的起始时间')
    return {'mode':mode,'coefficient':coefficient,'exponent':exponent,'unit':unit,
            'volume_value':volume,'volume_unit':volume_unit,'measured_at':measured}


def estimate_total(value):
    if not value or value.get('mode')!='concentration' or not value.get('volume_value'):
        return ''
    concentration={'cells/mL':Decimal(1),'个/mL':Decimal(1),'cells/μL':Decimal(1000),
                   'cells/µL':Decimal(1000),'cells/uL':Decimal(1000),'个/μL':Decimal(1000),'个/µL':Decimal(1000),'个/uL':Decimal(1000)}
    volume={'mL':Decimal(1),'L':Decimal(1000),'μL':Decimal('.001'),'µL':Decimal('.001'),'uL':Decimal('.001')}
    if value.get('unit') not in concentration or value.get('volume_unit') not in volume:return ''
    try:
        total=Decimal(value['coefficient']).scaleb(int(value['exponent']))*concentration[value['unit']]*Decimal(value['volume_value'])*volume[value['volume_unit']]
        if not total.is_finite():return ''
        return format(total.normalize(),'E')+' cells'
    except (DecimalException,ValueError,KeyError,OverflowError):return ''


def count_summary(value):
    if not value:return '未记录细胞计数'
    label='浓度' if value['mode']=='concentration' else '总细胞数'
    lines=[f'{label}：{value["coefficient"]} × 10^{value["exponent"]} {value["unit"]}',f'计数时间：{value["measured_at"]}']
    if value.get('volume_value'):lines.append(f'大致培养基体积：{value["volume_value"]} {value["volume_unit"]}')
    estimated=estimate_total(value)
    if estimated:lines.append('按大致体积估算总数 ≈ '+estimated)
    return '\n'.join(lines)


def normalize_seeding(value):
    """One explicitly entered amount per destination unit, not a measurement."""
    if not isinstance(value, dict) or set(value) != {'coefficient', 'exponent', 'unit'}:
        raise ValueError('铺入细胞数须包含数值、指数和单位')
    coefficient = number(value['coefficient'], '铺入细胞数')
    exponent = text(value['exponent'], '铺入数量指数', 12)
    unit = text(value['unit'], '铺入数量单位', 100)
    if not coefficient or not re.fullmatch(r'[+-]?\d+', exponent) or not unit:
        raise ValueError('请填写铺入细胞数、整数指数和单位')
    return {'coefficient': coefficient, 'exponent': str(int(exponent)), 'unit': unit}


def seeding_summary(value):
    if not value:
        return ''
    label = '本次加入' if value.get('addition') else '铺入'
    return (f'{label}：{value["coefficient"]} × 10^{value["exponent"]} {value["unit"]} / {value["per"]}'
            f' · 操作时间 {value["at"]}')
