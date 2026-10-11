"""Generates templates/ads-campaign.json, the Ads Campaign product's n8n workflow.

Run from the repository root: python3 scripts/gen-ads-template.py
The output is what the creator uploads (Creator studio). Nothing here talks to n8n.
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "templates" / "ads-campaign.json"

INPUTS = [
    "action", "adAccountId", "pageId", "name", "objective", "dailyBudgetCents",
    "startsAt", "endsAt", "countries", "ageMin", "ageMax", "platforms",
    "caption", "linkUrl", "mediaUrl", "campaignId", "confirmedMaxTotalCents",
]

def http(id_, name, pos, url, body):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
        "position": pos,
        "parameters": {
            "method": "POST", "url": url, "authentication": "none",
            "sendHeaders": True, "specifyHeaders": "keypair",
            "headerParameters": {"parameters": [{"name": "Authorization", "value": "Bearer __MP_KNOWLEDGE_KEY__"}]},
            "sendBody": True, "specifyBody": "json", "jsonBody": body,
            # The platform's own answer, errors included, comes back as data for the reply.
            "options": {"response": {"response": {"neverError": True}}},
        },
    }

def reply(id_, name, pos, text):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.set", "typeVersion": 3.4, "position": pos,
        "parameters": {"assignments": {"assignments": [{"id": "o1", "name": "output", "type": "string", "value": text}]}, "options": {}},
    }

def if_node(id_, name, pos, value, expected):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.if", "typeVersion": 2.2, "position": pos,
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "conditions": [{
                    "id": "c1", "leftValue": value, "rightValue": expected,
                    "operator": {"type": "string", "operation": "equals"},
                }],
                "combinator": "and",
            },
            "options": {},
        },
    }

CREATE_BODY = (
    "={{ JSON.stringify({ "
    "adAccountId: $json.adAccountId, pageId: $json.pageId, name: $json.name, "
    "objective: $json.objective, dailyBudgetCents: Number($json.dailyBudgetCents), "
    "startsAt: $json.startsAt, endsAt: $json.endsAt, "
    "targeting: { countries: String($json.countries).split(',').map(s => s.trim().toUpperCase()).filter(Boolean), "
    "ageMin: Number($json.ageMin), ageMax: Number($json.ageMax) }, "
    "platforms: String($json.platforms).split(',').map(s => s.trim().toLowerCase()).filter(Boolean), "
    "caption: $json.caption, linkUrl: $json.linkUrl, "
    "mediaUrl: ($json.mediaUrl && $json.mediaUrl !== 'none') ? $json.mediaUrl : undefined }) }}"
)
ACTIVATE_BODY = "={{ JSON.stringify({ confirmedMaxTotalCents: Number($json.confirmedMaxTotalCents) }) }}"

CREATE_REPLY = (
    "={{ $json.id ? ('تم إنشاء الحملة (' + $json.id + ') بحالة متوقفة، ولم يُصرف شيء بعد. '"
    " + 'المراجعة: ' + $json.review.lines.join(' | ')"
    " + '. أقصى إنفاق ممكن: ' + $json.review.maxTotalCents + ' (بالوحدة الصغرى). أكّد هذا المبلغ لأفعّلها.')"
    " : ('تعذّر إنشاء الحملة: ' + ($json.errors ? $json.errors.join(' ') : ($json.error || 'خطأ غير معروف'))) }}"
)
ACTIVATE_REPLY = (
    "={{ $json.status === 'ACTIVE' ? ('تم تفعيل الحملة (' + $json.id + ')، وستُصرف الميزانية وفق المراجعة.')"
    " : ('لم تُفعَّل الحملة: ' + ($json.errors ? $json.errors.join(' ') : ($json.error || 'خطأ غير معروف'))) }}"
)

nodes = [
    {
        "id": "a0000000-0000-4000-8000-000000000001", "name": "Ads Trigger",
        "type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1.1, "position": [192, 848],
        "parameters": {
            "inputSource": "workflowInputs",
            "workflowInputs": {"values": [{"name": n, "type": "string"} for n in INPUTS]},
        },
    },
    if_node("a0000000-0000-4000-8000-000000000002", "Is Create?", [416, 848], "={{ $json.action }}", "create"),
    http("a0000000-0000-4000-8000-000000000003", "Create Campaign", [672, 752],
         "__MP_PLATFORM_URL__/api/ads/campaigns", CREATE_BODY),
    reply("a0000000-0000-4000-8000-000000000004", "Reply Review", [896, 752], CREATE_REPLY),
    http("a0000000-0000-4000-8000-000000000005", "Activate Campaign", [672, 944],
         "=__MP_PLATFORM_URL__/api/ads/campaigns/{{ encodeURIComponent($json.campaignId) }}/activate", ACTIVATE_BODY),
    reply("a0000000-0000-4000-8000-000000000006", "Reply Activated", [896, 944], ACTIVATE_REPLY),
]

def edge(src, dst, index=0):
    return {"node": dst, "type": "main", "index": index}

connections = {
    "Ads Trigger": {"main": [[edge("Ads Trigger", "Is Create?")]]},
    # IF: output 0 is true (create), output 1 is false (activate).
    "Is Create?": {"main": [[edge("Is Create?", "Create Campaign")], [edge("Is Create?", "Activate Campaign")]]},
    "Create Campaign": {"main": [[edge("Create Campaign", "Reply Review")]]},
    "Activate Campaign": {"main": [[edge("Activate Campaign", "Reply Activated")]]},
}

template = {"name": "Ads Campaign", "nodes": nodes, "connections": connections, "settings": {"executionOrder": "v1"}}
OUT.write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("wrote", OUT)
