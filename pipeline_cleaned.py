import getpass
import json
import re
import time

import nltk
import requests
from google import genai
from google.genai import types

nltk.download('punkt_tab', quiet=True)

# --- Configuration ---
# Set USE_FALSE_INFO_TEST = True to run against the "false info" test file/output.
USE_FALSE_INFO_TEST = False

if USE_FALSE_INFO_TEST:
    file_location = "/content/drive/MyDrive/AI Hackhaton Data/test2.txt"
    file_save_location = "/content/drive/MyDrive/AI Hackhaton Data/result2.json"
else:
    file_location = "/content/drive/MyDrive/AI Hackhaton Data/test.txt"
    file_save_location = "/content/drive/MyDrive/AI Hackhaton Data/result.json"

SENTENCES_PER_BATCH = 10
MAX_RETRIES = 1

JSON_ONLY_RULE = (
    "\n\nRespond ONLY with raw JSON matching the shape described above. "
    "No markdown code fences, no backticks, no explanation, nothing before or after it."
)

# Same four platforms the web interface offers. "supports_search" marks whether
# a platform has a real live-search tool behind it, or would just be answering
# from its own memory if picked for the search step.
PLATFORMS = {
    "claude": {
        "label": "Claude (Anthropic)",
        "models": ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
        "key_label": "Anthropic API key",
        "supports_search": True,
    },
    "gemini": {
        "label": "Gemini (Google)",
        "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
        "key_label": "Google AI API key",
        "supports_search": True,
    },
    "openai": {
        "label": "ChatGPT (OpenAI)",
        "models": ["gpt-4.1", "gpt-4.1-mini", "o3-mini"],
        "key_label": "OpenAI API key",
        "supports_search": True,
    },
    "cordatus": {
        "label": "Cordatus (local)",
        "models": ["mobil-app-model"],
        "key_label": "Cordatus API key",
        "supports_search": False,
    },
}


def choose_platform(role_label):
    """Asks which platform, which model, and collects that platform's key."""
    print(f"\nWhich platform should handle {role_label}?")
    keys = list(PLATFORMS.keys())
    for i, key in enumerate(keys, start=1):
        print(f"  {i}) {PLATFORMS[key]['label']}")
    choice = input("Enter a number: ").strip()
    platform = keys[int(choice) - 1] if choice.isdigit() and 1 <= int(choice) <= len(keys) else keys[0]

    info = PLATFORMS[platform]
    if role_label == "web search" and not info["supports_search"]:
        print(f"Note: {info['label']} has no live search tool — it will only answer from what it already knows.")

    print("Which model?")
    for i, model_name in enumerate(info["models"], start=1):
        print(f"  {i}) {model_name}")
    print(f"  {len(info['models']) + 1}) custom model string")
    model_choice = input("Enter a number: ").strip()
    if model_choice.isdigit() and 1 <= int(model_choice) <= len(info["models"]):
        model = info["models"][int(model_choice) - 1]
    else:
        model = input("Enter the model string: ").strip()

    apikey = getpass.getpass(f"Enter your {info['key_label']}: ").strip()

    return platform, model, apikey


def ask_for_setup():
    llm_platform, llm_model, llm_apikey = choose_platform("extraction & verdicts (LLM)")
    search_platform, search_model, search_apikey = choose_platform("web search")
    return {
        "llm": (llm_platform, llm_model, llm_apikey),
        "search": (search_platform, search_model, search_apikey),
    }


def clean_json_text(text):
    return re.sub(r"```json\s*|```", "", text).strip()


# ---------- one call function per platform ----------

def call_claude(model, apikey, system_instruction, content, want_search=False):
    payload = {
        "model": model,
        "max_tokens": 2048,
        "system": system_instruction,
        "messages": [{"role": "user", "content": content}],
    }
    if want_search:
        payload["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]

    headers = {
        "Content-Type": "application/json",
        "x-api-key": apikey,
        "anthropic-version": "2023-06-01",
    }

    response = requests.post("https://api.anthropic.com/v1/messages", headers=headers, json=payload)
    response.raise_for_status()
    data = response.json()
    return "\n".join(block["text"] for block in data["content"] if block["type"] == "text")


def call_gemini(model, apikey, system_instruction, content, want_search=False):
    client = genai.Client(api_key=apikey)

    config_kwargs = {
        "system_instruction": system_instruction,
        "temperature": 0.1,
    }
    if want_search:
        config_kwargs["tools"] = [types.Tool(google_search=types.GoogleSearch())]

    response = client.models.generate_content(
        model=model,
        config=types.GenerateContentConfig(**config_kwargs),
        contents=content,
    )
    return response.text


def call_openai(model, apikey, system_instruction, content, want_search=False):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {apikey}",
    }

    if want_search:
        # web search lives on the Responses API, not classic chat completions
        payload = {
            "model": model,
            "instructions": system_instruction,
            "input": content,
            "tools": [{"type": "web_search_preview"}],
        }
        response = requests.post("https://api.openai.com/v1/responses", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        chunks = []
        for item in data.get("output", []):
            for piece in item.get("content", []):
                if piece.get("type") == "output_text" and piece.get("text"):
                    chunks.append(piece["text"])
        return "\n".join(chunks)

    payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": content},
        ],
    }
    response = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


def call_cordatus(model, apikey, system_instruction, content, want_search=False):
    # No search tool exists here; want_search is accepted just to keep the
    # same call signature as the other platforms and is otherwise ignored.
    headers = {
        "Content-Type": "application/json",
        "Authorization": apikey if apikey.lower().startswith("bearer ") else f"Bearer {apikey}",
    }

    data = {
        "model": model or "mobil-app-model",
        "messages": [
            {
                "role": "user",
                "content": f"Instruction: {system_instruction}\n\nText to process: {content}",
            }
        ],
        "stream": True,
        "temperature": 0.1,
        "max_tokens": 4096,
    }

    response = requests.post(
        "https://cordatus-model.cordatus.ai/v1/chat/completions", headers=headers, json=data, stream=True
    )
    response.raise_for_status()

    pieces = []
    for line in response.iter_lines():
        if not line:
            continue
        line_str = line.decode("utf-8").strip()
        if line_str.startswith("data: ") and not line_str.endswith("[DONE]"):
            chunk = json.loads(line_str[6:])
            delta = chunk["choices"][0]["delta"]
            content_chunk = delta.get("content", "")
            if content_chunk:
                pieces.append(content_chunk)

    return "".join(pieces)


CALL_FUNCTIONS = {
    "claude": call_claude,
    "gemini": call_gemini,
    "openai": call_openai,
    "cordatus": call_cordatus,
}


def call_platform(platform, model, apikey, system_instruction, content, want_search=False):
    return CALL_FUNCTIONS[platform](model, apikey, system_instruction, content, want_search)


def llm_generate(platform, model, apikey, content, instruction):
    """For steps that must come back as JSON: extraction, conflict check, evaluation."""
    full_instruction = instruction + JSON_ONLY_RULE
    raw_output = call_platform(platform, model, apikey, full_instruction, content)
    return clean_json_text(raw_output)


def write_to_json(input_path, output_path):
    with open(input_path, mode='r', encoding='utf-8') as file:
        raw_file = file.read().strip()

    raw_sentences = nltk.sent_tokenize(raw_file)
    clean_sentences = [s.strip() for s in raw_sentences if s.strip()]

    article_data = {
        "document_type": "article",
        "total_sentences": len(clean_sentences),
        "sentences": clean_sentences,
    }

    with open(output_path, mode='w', encoding='utf-8') as json_file:
        json.dump(article_data, json_file, indent=4, ensure_ascii=False)


def parse_facts_and_questions_from_llm_output(llm_output_str):
    data = json.loads(llm_output_str.strip())
    return data["facts"], data["questions"]


def list_the_questions(input_path, process_num, llm_platform, llm_model, llm_apikey):
    with open(input_path, mode='r', encoding='utf-8') as file:
        data = json.load(file)

    total_sentences = data['total_sentences']
    process_list = []
    output_list = []

    instruction = (
        "You are a helpful assistant. ONLY RETURN: the scientific and numerical facts from text "
        "and convert these facts into neutral questions. "
        "Example: input -> speed of chita is 120 miles per hour -> How fast does chita moves?, "
        "input -> water is in the form of liquid -> What is the physical form of the water? "
        "Return a JSON object with two arrays, 'facts' and 'questions', the same length and in the "
        "same order."
    )

    for i, sentence in enumerate(data['sentences']):
        process_list.append(sentence)
        current_count = i + 1

        if (current_count % process_num == 0) or (current_count == total_sentences):
            processed_text_for_llm = " ".join(process_list)
            output_list.append(
                llm_generate(llm_platform, llm_model, llm_apikey, processed_text_for_llm, instruction)
            )
            process_list = []

    all_extracted_facts = []
    all_extracted_questions = []

    for llm_response_json_str in output_list:
        facts_batch, questions_batch = parse_facts_and_questions_from_llm_output(llm_response_json_str)
        all_extracted_facts.extend(facts_batch)
        all_extracted_questions.extend(questions_batch)

    return all_extracted_facts, all_extracted_questions


def web_search(questions, search_platform, search_model, search_apikey):
    instruction = (
        "You are a helpful AI assistant. You must consult exactly 3 distinct web resources "
        "to answer the given question. Cite the resources you have used."
    )
    return call_platform(search_platform, search_model, search_apikey, instruction, questions, want_search=True)


def evaluation(web_search_answer, facts_list, llm_platform, llm_model, llm_apikey):
    instruction = (
        "You are an AI assistant tasked with comparing information. "
        "Given a list of extracted facts from an original text and answers obtained from a web search, "
        "your goal is to evaluate the quality of the web search answers. Specifically, you need to:\n"
        "1. Identify if the web search answers accurately address the questions and align with the "
        "extracted facts from the original text.\n"
        "2. Note any discrepancies or contradictions between the web search answers and the extracted "
        "facts from the original text.\n"
        "3. Highlight any significant new information provided by the web search that was not in the "
        "original text or facts.\n"
        "4. Summarize your findings for each question or overall.\n"
        "Return a JSON object shaped like: "
        "{\"evaluation_summary\": \"...\", \"discrepancies\": [...], \"new_information\": [...]}"
    )

    content = (
        f"Extracted Facts from Original Text:\n{facts_list}\n\n"
        f"Web Search Answers:\n{web_search_answer}"
    )

    return llm_generate(llm_platform, llm_model, llm_apikey, content, instruction)


def check_context(web_search_answer, facts_list, llm_platform, llm_model, llm_apikey):
    instruction = (
        "You are an AI assistant. Your task is to analyze the provided web search answers in the context "
        "of the given facts. Identify if there are crucial, conflicting pieces of information within the "
        "web search results themselves. Crucial conflicts are direct contradictions on factual information "
        "across different parts of the web search answers, not minor phrasing differences or additional "
        "details. Return a JSON object with two keys: "
        "`has_crucial_conflicts` (boolean) and `conflict_description` (string, a summary of crucial "
        "conflicts if any, or 'No crucial conflicts detected.')."
    )

    content_for_llm = (
        "Facts from Original Text:\n"
        + "\n".join(f"- {f}" for f in facts_list)
        + f"\n\nWeb Search Answers:\n{web_search_answer}"
    )

    conflict_check_output = llm_generate(llm_platform, llm_model, llm_apikey, content_for_llm, instruction)

    try:
        parsed_output = json.loads(conflict_check_output)
        has_crucial_conflicts = parsed_output.get("has_crucial_conflicts", False)
        conflict_description = parsed_output.get("conflict_description", "Could not parse conflict description.")
        return has_crucial_conflicts, conflict_description
    except json.JSONDecodeError:
        return True, "Error: LLM returned malformed JSON for conflict check."


def main():
    setup = ask_for_setup()
    llm_platform, llm_model, llm_apikey = setup["llm"]
    search_platform, search_model, search_apikey = setup["search"]

    write_to_json(file_location, file_save_location)
    facts, questions = list_the_questions(
        file_save_location, SENTENCES_PER_BATCH, llm_platform, llm_model, llm_apikey
    )

    final_web_search_result = ""

    for retry_attempt in range(MAX_RETRIES):
        result = web_search(questions, search_platform, search_model, search_apikey)
        has_conflicts, conflict_desc = check_context(result, facts, llm_platform, llm_model, llm_apikey)

        if not has_conflicts:
            final_web_search_result = result
            break

        print(f"Crucial conflicts found: {conflict_desc}")
        if retry_attempt < MAX_RETRIES - 1:
            print("Retrying web search...")
            time.sleep(5)
        else:
            print("Max retries reached. Proceeding with potentially conflicting results.")
            final_web_search_result = result

    evaluation_report = evaluation(final_web_search_result, facts, llm_platform, llm_model, llm_apikey)
    print("\n--- Evaluation Report ---")
    print(evaluation_report)


if __name__ == "__main__":
    main()
