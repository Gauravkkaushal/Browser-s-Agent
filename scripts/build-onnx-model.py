import os
import json
import numpy as np
import onnx
from onnx import helper, TensorProto

# Define vocabulary: 10 keywords per intent (8 intents = 80 tokens) + 10 general interaction tokens = 90 total
VOCABULARY = [
    # 0: login intent tokens (0-9)
    "login", "signin", "password", "user", "username", "email", "auth", "account", "passcode", "credential",
    # 1: pay intent tokens (10-19)
    "pay", "payment", "checkout", "card", "cvv", "buy", "purchase", "upi", "billing", "order",
    # 2: save intent tokens (20-29)
    "save", "submit", "store", "confirm", "apply", "done", "keep", "finish", "record", "commit",
    # 3: send intent tokens (30-39)
    "send", "message", "chat", "post", "transfer", "forward", "dispatch", "share", "mail", "sms",
    # 4: search intent tokens (40-49)
    "search", "find", "query", "lookup", "explore", "filter", "browse", "seek", "check", "inspect",
    # 5: delete intent tokens (50-59)
    "delete", "remove", "clear", "discard", "trash", "erase", "cancel", "purge", "reset", "drop",
    # 6: navigate intent tokens (60-69)
    "navigate", "go", "back", "forward", "home", "open", "redirect", "visit", "jump", "switch",
    # 7: download intent tokens (70-79)
    "download", "export", "fetch", "extract", "saveas", "backup", "grab", "pull", "retrieve", "archive",
    # General UI / helper tokens (80-89)
    "click", "button", "input", "form", "field", "select", "enter", "press", "next", "continue"
]

CLASSES = ["login", "pay", "save", "send", "search", "delete", "navigate", "download"]

num_features = len(VOCABULARY)
num_classes = len(CLASSES)

# Initialize weight matrix [num_features, num_classes]
W = np.zeros((num_features, num_classes), dtype=np.float32)

# Assign high positive weights to domain-specific tokens for each intent
for i in range(10):
    W[i, 0] = 2.5       # login
    W[10 + i, 1] = 2.5  # pay
    W[20 + i, 2] = 2.5  # save
    W[30 + i, 3] = 2.5  # send
    W[40 + i, 4] = 2.5  # search
    W[50 + i, 5] = 2.5  # delete
    W[60 + i, 6] = 2.5  # navigate
    W[70 + i, 7] = 2.5  # download

# General UI tokens give modest activation to standard interactive intents
for i in range(80, 90):
    W[i, 2] += 0.2  # save/submit
    W[i, 4] += 0.2  # search/inspect
    W[i, 6] += 0.2  # navigate

# Biases
B = np.zeros((num_classes,), dtype=np.float32)

# Create ONNX graph
# Input: input_features [1, num_features]
input_tensor = helper.make_tensor_value_info("input_features", TensorProto.FLOAT, [1, num_features])

# Output: probabilities [1, num_classes], label [1, 1]
output_prob = helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [1, num_classes])
output_label = helper.make_tensor_value_info("label", TensorProto.INT64, [1, 1])

# Initializers for weights & biases
w_init = helper.make_tensor("W", TensorProto.FLOAT, [num_features, num_classes], W.flatten().tolist())
b_init = helper.make_tensor("B", TensorProto.FLOAT, [num_classes], B.flatten().tolist())

# Nodes
# 1. Gemm: Y = input_features * W + B
gemm_node = helper.make_node(
    "Gemm",
    inputs=["input_features", "W", "B"],
    outputs=["logits"],
    alpha=1.0,
    beta=1.0,
    transA=0,
    transB=0
)

# 2. Softmax: probabilities = Softmax(logits, axis=1)
softmax_node = helper.make_node(
    "Softmax",
    inputs=["logits"],
    outputs=["probabilities"],
    axis=1
)

# 3. ArgMax: label = ArgMax(probabilities, axis=1, keepdims=1)
argmax_node = helper.make_node(
    "ArgMax",
    inputs=["probabilities"],
    outputs=["label"],
    axis=1,
    keepdims=1
)

# Create graph
graph = helper.make_graph(
    nodes=[gemm_node, softmax_node, argmax_node],
    name="NetraShieldIntentClassifier",
    inputs=[input_tensor],
    outputs=[output_prob, output_label],
    initializer=[w_init, b_init]
)

# Create model (ONNX opset 17)
model = helper.make_model(graph, producer_name="NetraShield-ML-Pipeline", opset_imports=[helper.make_operatorsetid("", 17)])
onnx.checker.check_model(model)

# Save to public/models/intent-classifier.onnx
os.makedirs("public/models", exist_ok=True)
model_path = "public/models/intent-classifier.onnx"
onnx.save(model, model_path)
print(f"Model saved successfully to {model_path}")

# Also save vocabulary and metadata for runtime feature extractor
metadata = {
    "vocabulary": VOCABULARY,
    "classes": CLASSES,
    "feature_dim": num_features,
    "opset": 17
}

os.makedirs("src/shared/lib", exist_ok=True)
with open("src/shared/lib/modelVocab.json", "w") as f:
    json.dump(metadata, f, indent=2)
print("Metadata written to src/shared/lib/modelVocab.json")
