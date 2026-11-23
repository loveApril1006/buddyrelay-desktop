<?php
// Public HTTP bridge to the private, loopback-only portal process.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (strpos($path, '..') !== false) { http_response_code(400); exit; }
$ch = curl_init('http://127.0.0.1:18787' . $_SERVER['REQUEST_URI']);
$headers = ['Host: ' . $_SERVER['HTTP_HOST']];
foreach (['Content-Type', 'Authorization', 'Cookie', 'Origin', 'Idempotency-Key'] as $name) {
    $key = $name === 'Content-Type' ? 'CONTENT_TYPE' : 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$key])) $headers[] = $name . ': ' . $_SERVER[$key];
}
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $_SERVER['REQUEST_METHOD'],
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 200,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADERFUNCTION => function ($curl, $line) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $match)) http_response_code((int)$match[1]);
        elseif (preg_match('/^(Content-Type|Cache-Control|Set-Cookie|X-Request-Id|X-Cache|Content-Security-Policy|X-Content-Type-Options|Referrer-Policy):/i', $line)) header(trim($line), false);
        return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => function ($curl, $data) {
        echo $data;
        if (ob_get_level()) ob_flush();
        flush();
        return strlen($data);
    },
]);
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'HEAD') {
    $input = file_get_contents('php://input', false, null, 0, 1048577);
    if (strlen($input) > 1048576) { http_response_code(413); exit; }
    curl_setopt($ch, CURLOPT_POSTFIELDS, $input);
}
if (!curl_exec($ch) && !headers_sent()) {
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => ['message' => '服务正在启动，请稍后重试']], JSON_UNESCAPED_UNICODE);
}
curl_close($ch);
