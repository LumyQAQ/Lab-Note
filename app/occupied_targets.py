"""Validation for explicit edits to occupied transfer destinations."""


def validate_occupied_options(targets):
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError('无效目标')
        if 'occupied_confirmed' in target and type(target['occupied_confirmed']) is not bool:
            raise ValueError('已有细胞目标的确认状态须为布尔值')
        if 'occupied_action' in target and target['occupied_action'] not in ('link', 'replace', 'append'):
            raise ValueError('请选择补充来源关联、替换现有细胞或追加合并')


def source_only_links(index, targets, containers):
    """Archived or mixed sources may only feed existing metadata corrections."""
    routes = [target for target in targets
              if isinstance(target.get('source_indices'), list) and index in target['source_indices']]
    if not routes:
        return False
    for target in routes:
        c = containers.get(target.get('id'))
        keys = target.get('wells')
        if (target.get('occupied_action') != 'link' or not c or c['status'] != 'active'
                or not isinstance(keys, list) or not keys
                or any(not isinstance(key, str) or key not in c['wells']
                       or not c['wells'][key].get('cell') for key in keys)):
            return False
    return True


def validate_link_cycles(containers, targets):
    """Reject a new current-reference cycle reachable from any changed target.

    The caller supplies the fully staged state, so every new target edge is
    checked together. Historical receipts and missing historical units are not
    rewritten or treated as current edges.
    """
    for target in targets:
        root = (target['id'], target['well'])
        visited = set()
        pending = [root]
        while pending:
            node = pending.pop()
            if node in visited:
                continue
            visited.add(node)
            c = containers.get(node[0])
            w = c['wells'].get(node[1], {}) if c else {}
            for ref in w.get('source_refs', []):
                parent = (ref.get('id'), ref.get('well'))
                if parent == root:
                    raise ValueError('来源关联会形成循环；不能让后代成为其自身的来源，请另建目标培养单元')
                if parent not in visited:
                    pending.append(parent)
